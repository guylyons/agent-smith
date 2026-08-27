// The art-background layer. The chosen background is applied to <html data-bg>
// by the Settings panel (and on load by App); this just renders the layer.
export function Backdrop() {
  return <div className="artbg" aria-hidden="true"></div>;
}
