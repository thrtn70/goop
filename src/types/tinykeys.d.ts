// Shim for tinykeys — its types ship at `dist/tinykeys.d.ts` but aren't
// exposed via the package's `exports` map, so TypeScript can't resolve
// them through normal import. Re-declare the minimum surface we use.

declare module "tinykeys" {
  type KeyBindingHandler = (event: KeyboardEvent) => void;
  type KeyBindingMap = Record<string, KeyBindingHandler>;

  interface KeyBindingOptions {
    timeout?: number;
    event?: "keydown" | "keyup";
    capture?: boolean;
  }

  export function tinykeys(
    target: Window | HTMLElement,
    keyBindingMap: KeyBindingMap,
    options?: KeyBindingOptions,
  ): () => void;
}
