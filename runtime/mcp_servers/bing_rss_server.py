"""Minimal stdio MCP server for Bing search using the RSS endpoint.

This avoids the HTML search page, which is often gated by anti-bot checks
from Bing/Cloudflare and causes empty result sets for scraper-based packages.
"""

from __future__ import annotations

import html
import json
import logging
import re
import sys
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

import httpx


LOGGER = logging.getLogger("bing_rss_mcp")
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
BING_RSS_URL = "https://www.bing.com/search"
# Bing RSS 在并发下容易超时；把 search 超时从 20s 降到 10s + 1 次重试，
# 总体延迟不差于原先，但让上游 LLM 更早拿到失败信号并切换策略。
REQUEST_TIMEOUT = 10.0
SEARCH_MAX_ATTEMPTS = 2
CRAWLER_BLACKLIST = {
    "zhihu.com",
    "www.zhihu.com",
    "zhuanlan.zhihu.com",
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "xhs.com",
    "weibo.com",
    "www.weibo.com",
    "m.weibo.com",
    "weixin.qq.com",
    "mp.weixin.qq.com",
    "douyin.com",
    "www.douyin.com",
    "tiktok.com",
    "www.tiktok.com",
    "bilibili.com",
    "www.bilibili.com",
    "m.bilibili.com",
    "csdn.net",
    "www.csdn.net",
    "blog.csdn.net",
}


def _write_message(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _write_result(request_id: Any, result: Dict[str, Any]) -> None:
    _write_message({"jsonrpc": "2.0", "id": request_id, "result": result})


def _write_error(request_id: Any, code: int, message: str) -> None:
    _write_message(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }
    )


def _tool_response_text(data: Any) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}


def _normalize_whitespace(text: str) -> str:
    text = html.unescape(text)
    text = re.sub(r"<(script|style|nav|footer|header|iframe|noscript)\b.*?</\1>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|section|article|li|h[1-6])>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _is_blacklisted(url: str) -> bool:
    try:
        hostname = urlparse(url).hostname or ""
    except ValueError:
        return False
    hostname = hostname.lower()
    return any(hostname == domain or hostname.endswith(f".{domain}") for domain in CRAWLER_BLACKLIST)


def _fetch_bing_rss(query: str, count: int = 10, offset: int = 0) -> Dict[str, Any]:
    params = {
        "q": query,
        "format": "rss",
        "first": offset + 1,
        "count": max(1, min(count, 50)),
        "mkt": "zh-CN",
    }
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    last_exc: Optional[Exception] = None
    rss_text: Optional[str] = None
    for attempt in range(1, SEARCH_MAX_ATTEMPTS + 1):
        try:
            with httpx.Client(timeout=REQUEST_TIMEOUT, follow_redirects=True, headers=headers) as client:
                response = client.get(BING_RSS_URL, params=params)
                response.raise_for_status()
                rss_text = response.text
            break
        except (httpx.TimeoutException, httpx.HTTPError) as exc:
            last_exc = exc
            LOGGER.warning(
                "[BingRSS] search attempt %s/%s failed: %s",
                attempt,
                SEARCH_MAX_ATTEMPTS,
                exc,
            )
    if rss_text is None:
        assert last_exc is not None
        raise last_exc

    root = ET.fromstring(rss_text)
    items = root.findall("./channel/item")
    results: List[Dict[str, Any]] = []
    for index, item in enumerate(items[offset : offset + count], start=offset + 1):
        title = (item.findtext("title") or "").strip()
        url = (item.findtext("link") or "").strip()
        snippet = (item.findtext("description") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        if not title or not url:
            continue
        results.append(
            {
                "uuid": f"rss-{index}",
                "title": title,
                "url": url,
                "snippet": snippet,
                "displayUrl": url,
                "pubDate": pub_date,
            }
        )

    return {
        "query": query,
        "results": results,
        "totalResults": len(results),
        "source": "bing_rss",
    }


def _crawl_pages(uuids: List[str], url_map: Dict[str, str]) -> List[Dict[str, Any]]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    results: List[Dict[str, Any]] = []
    with httpx.Client(timeout=30.0, follow_redirects=True, headers=headers) as client:
        for uuid in uuids:
            url = url_map.get(uuid, "")
            if not url:
                results.append({"uuid": uuid, "error": "urlMap 中不存在该 UUID"})
                continue
            if _is_blacklisted(url):
                results.append(
                    {
                        "uuid": uuid,
                        "url": url,
                        "error": "该网站在爬虫黑名单中，禁止抓取",
                        "isBlacklisted": True,
                    }
                )
                continue
            try:
                response = client.get(url)
                response.raise_for_status()
                title_match = re.search(r"<title[^>]*>(.*?)</title>", response.text, flags=re.I | re.S)
                title = _normalize_whitespace(title_match.group(1)) if title_match else ""
                content = _normalize_whitespace(response.text)
                if len(content) < 50:
                    raise ValueError("提取的内容太少或为空")
                results.append(
                    {
                        "uuid": uuid,
                        "url": url,
                        "title": title,
                        "content": content[:12000],
                    }
                )
            except Exception as exc:  # noqa: BLE001
                results.append({"uuid": uuid, "url": url, "error": str(exc)})
    return results


TOOLS = [
    {
        "name": "bing_search",
        "description": "使用 Bing RSS 搜索网络信息，返回标题、链接和摘要。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词或查询语句"},
                "count": {
                    "type": "number",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 10,
                    "description": "返回结果数量，默认10条，最多50条",
                },
                "offset": {
                    "type": "number",
                    "minimum": 0,
                    "default": 0,
                    "description": "结果偏移量，用于分页，默认0",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "crawl_webpage",
        "description": "根据搜索结果的 UUID 抓取网页内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "uuids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "description": "搜索结果的 UUID 列表",
                },
                "urlMap": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                    "description": 'UUID 到 URL 的映射，如 {"uuid": "https://example.com"}',
                },
            },
            "required": ["uuids", "urlMap"],
        },
    },
]


def _handle_tool_call(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    if name == "bing_search":
        query = str(arguments.get("query", "")).strip()
        if not query:
            raise ValueError("query 不能为空")
        count = int(arguments.get("count", 10) or 10)
        offset = int(arguments.get("offset", 0) or 0)
        return _tool_response_text(_fetch_bing_rss(query=query, count=count, offset=offset))

    if name == "crawl_webpage":
        uuids = arguments.get("uuids") or []
        url_map = arguments.get("urlMap") or {}
        if not isinstance(uuids, list) or not isinstance(url_map, dict):
            raise ValueError("uuids 和 urlMap 参数格式不正确")
        return _tool_response_text(_crawl_pages(uuids=uuids, url_map=url_map))

    raise ValueError(f"未知工具: {name}")


def main() -> None:
    LOGGER.info("Starting Bing RSS MCP server")
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = message.get("method")
        request_id = message.get("id")

        try:
            if method == "initialize":
                _write_result(
                    request_id,
                    {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "bing-rss-search", "version": "1.0.0"},
                    },
                )
            elif method == "notifications/initialized":
                continue
            elif method == "tools/list":
                _write_result(request_id, {"tools": TOOLS})
            elif method == "tools/call":
                params = message.get("params") or {}
                name = params.get("name")
                arguments = params.get("arguments") or {}
                result = _handle_tool_call(name=name, arguments=arguments)
                _write_result(request_id, result)
            else:
                _write_error(request_id, -32601, f"Method not found: {method}")
        except Exception as exc:  # noqa: BLE001
            _write_error(request_id, -32000, str(exc))


if __name__ == "__main__":
    main()
