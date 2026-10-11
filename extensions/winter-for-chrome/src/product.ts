// Winter for Chrome — the name the user sees. The build published on Edge Add-ons is the same extension under the name
// "Winter for Edge"; scripts/build.ts sets it per flavor (manifest.ts's PRODUCT_NAMES). The sources' own tests run without
// the define and see the Chrome name.
declare const __WINTER_PRODUCT_NAME__: string | undefined;

export const PRODUCT_NAME: string = typeof __WINTER_PRODUCT_NAME__ === "string" ? __WINTER_PRODUCT_NAME__ : "Winter for Chrome";
