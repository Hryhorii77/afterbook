// Shown instantly on navigation while /today's server render finishes
// (force-dynamic: a live tape read, a pool-state read and ten history
// lookups, which take a few seconds). Without it the previous page just
// sits there looking frozen after the click.
export default function Loading() {
  return (
    <main>
      <header className="top">
        <h1>Afterbook · Biggest gap</h1>
      </header>
      <section className="panel gap-hero today-hero" aria-busy="true">
        <p className="geo-note">Reading the tape…</p>
      </section>
    </main>
  );
}
