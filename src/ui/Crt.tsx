// The CRT overlay layers. The tube mode (CRT/SOFT/OFF) is applied to <html> by
// the Settings panel; this just renders the effect divs.
export function Crt() {
  return (
    <>
      <div className="crt crt-scan"></div>
      <div className="crt crt-grille"></div>
      <div className="crt crt-glow"></div>
      <div className="crt crt-hum"></div>
    </>
  );
}
