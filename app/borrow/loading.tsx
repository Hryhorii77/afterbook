// Shown while /borrow's server render reads Morpho's API, each market's
// oracle and the pools' tick liquidity (a few seconds cold).
export default function Loading() {
  return (
    <main>
      <header className="top">
        <h1>Borrow against stocks</h1>
      </header>
      <section className="panel" aria-busy="true">
        <p className="geo-note">Reading the lending markets…</p>
      </section>
    </main>
  );
}
