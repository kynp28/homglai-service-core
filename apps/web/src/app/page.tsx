export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-neutral-950 text-neutral-200">
      <div className="w-full max-w-4xl border border-neutral-800 bg-neutral-900/50 p-8 rounded-lg shadow-sm">
        <header className="border-b border-neutral-800 pb-4 mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Homglai Service Core
          </h1>
          <p className="text-sm text-neutral-400 mt-1">
            Enterprise Coffee Machine Repair and Lifecycle Tracking Platform
          </p>
        </header>
        <section className="space-y-4">
          <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="text-sm font-medium text-neutral-300">
              System Initialization Status
            </h2>
            <p className="text-xs text-neutral-500 mt-1">
              Workspace core initialized. Awaiting module configuration.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
