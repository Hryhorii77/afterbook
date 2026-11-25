// Shown instantly on navigation while /today's server render starts (force-dynamic: a live tape read and a
// pool-state read, about a second; the open leaderboard streams in separately, see page.tsx). Without it the
// previous page just sits there looking frozen after the click.
export default function Loading() {
  return (
    <main>
      <header className="top">
        <h1>Today&apos;s gap</h1>
      </header>
      <section className="panel gap-hero today-hero" aria-busy="true">
        <p className="geo-note">Reading the tape…</p>
      </section>
    </main>
  );
}
