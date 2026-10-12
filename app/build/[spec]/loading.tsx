// Shown while the basket's tape and pool reads finish (a few seconds cold).
export default function Loading() {
  return (
    <main>
      <header className="top">
        <h1>Build a basket</h1>
      </header>
      <section className="panel gap-hero today-hero" aria-busy="true">
        <p className="geo-note">Pricing the basket…</p>
      </section>
    </main>
  );
}
