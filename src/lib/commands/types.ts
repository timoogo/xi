/**
 * What every command may ask of the host to move the user elsewhere. Commands never import Next.js:
 * the palette adapts `router.push` and the current pathname into this shape.
 */
export type NavigationRuntime = {
  navigate: (href: string) => void;
  /** Pathname when the workflow started, for commands that make no sense on their own page. */
  pathname: string;
};
