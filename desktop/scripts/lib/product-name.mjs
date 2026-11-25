import desktopPackage from '../../package.json' with { type: 'json' };

// Keep the display name separate from the package name Electron uses for stored data.
export const productName = desktopPackage.config.product_name;
export const macBundleName = `${productName}.app`;
