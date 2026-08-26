import { useSnapshot } from "./useSnapshot";
import { Crt } from "./Crt";
import { Header } from "./Header";
import { Crew } from "./Crew";
import { TheLine } from "./TheLine";

export function App() {
  const snap = useSnapshot();
  return (
    <>
      <Crt />
      <Header snap={snap} />
      <Crew agents={snap.agents} />
      <TheLine line={snap.line} />
    </>
  );
}
