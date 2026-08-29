// Bun's bundler turns an image import into a URL string for the emitted asset.
// TypeScript needs telling; without this, `import faces from "./faces.png"` is
// an unresolved module.
declare module "*.png" {
  const src: string;
  export default src;
}
