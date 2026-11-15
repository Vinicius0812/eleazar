/** Vite resolves an imported SVG to its served URL. */
declare module "*.svg" {
  const url: string;
  export default url;
}
