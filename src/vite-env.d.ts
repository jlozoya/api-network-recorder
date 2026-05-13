/// <reference types="vite/client" />

declare const __BROWSER_TARGET__: "chrome" | "firefox"
declare const __SUPPORTS_DEEP_CAPTURE__: boolean

declare module "*.css" {
  const css: string
  export default css
}