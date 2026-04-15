import clsx from "clsx";

export default function DropOverlay({ active }: { active: boolean }) {
  return (
    <div
      className={clsx(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center transition-opacity",
        active ? "bg-sky-500/20 opacity-100" : "opacity-0"
      )}
      aria-hidden={!active}
    >
      {active && (
        <div className="rounded-xl border-4 border-dashed border-sky-400 px-8 py-6 text-2xl font-semibold text-white">
          Drop files to extract or convert
        </div>
      )}
    </div>
  );
}
