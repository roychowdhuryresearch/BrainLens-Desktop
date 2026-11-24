from datetime import datetime, timedelta
import os
from typing import Optional
from jose import JWTError, jwt
import bcrypt
from sqlalchemy.orm import Session
from runtime.models.user import User, get_db

JWT_SECRET_ENV = "IEEG_JWT_SECRET_KEY"
GENERIC_JWT_SECRET_ENV = "AGENT_JWT_SECRET_KEY"
SECRET_KEY = (os.getenv(JWT_SECRET_ENV) or os.getenv(GENERIC_JWT_SECRET_ENV) or "").strip()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24


def _get_secret_key() -> str:
    secret = (os.getenv(JWT_SECRET_ENV) or os.getenv(GENERIC_JWT_SECRET_ENV) or "").strip()
    if not secret:
        raise RuntimeError(
            f"{JWT_SECRET_ENV} is required for JWT operations "
            f"(fallback: {GENERIC_JWT_SECRET_ENV})"
        )
    return secret


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, _get_secret_key(), algorithm=ALGORITHM)
    return encoded_jwt


def decode_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, _get_secret_key(), algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


def authenticate_user(db: Session, username: str, password: str) -> Optional[User]:
    user = db.query(User).filter(User.username == username).first()
    if not user:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def get_user_by_username(db: Session, username: str) -> Optional[User]:
    return db.query(User).filter(User.username == username).first()


def get_user_by_id(db: Session, user_id: str) -> Optional[User]:
    return db.query(User).filter(User.id == user_id).first()


def get_all_users(db: Session) -> list:
    return db.query(User).all()


def create_user(db: Session, username: str, password: str, role: str = 'external') -> User:
    user = User(
        id=f"user-{datetime.utcnow().timestamp()}",
        username=username,
        password_hash=get_password_hash(password),
        role=role
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user(db: Session, user_id: str, **kwargs) -> Optional[User]:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None
    
    if 'password' in kwargs:
        kwargs['password_hash'] = get_password_hash(kwargs.pop('password'))
    
    for key, value in kwargs.items():
        if hasattr(user, key):
            setattr(user, key, value)
    
    user.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user_id: str) -> bool:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return False
    db.delete(user)
    db.commit()
    return True
