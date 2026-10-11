/** 由 public/vendor 中的 xterm 脚本提供的全局构造器。 */
export {};

declare global {
  interface Window {
    /** xterm.js 全局（由 public/vendor/xterm.js 提供）。 */
    Terminal: any;
    /** xterm fit 插件全局（由 public/vendor/xterm-addon-fit.js 提供）。 */
    FitAddon: any;
  }
}
