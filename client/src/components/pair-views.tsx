import { useCallback, useEffect, useRef, useState } from "react";
import { photoUrl, photoThumbUrl } from "@/lib/queryClient";
import type { PairWithPhotos } from "@shared/schema";
import { Columns2, ArrowLeftRight, X, Trash2, Pencil, ChevronLeft, ChevronRight, FolderInput, Play } from "lucide-react";

function VideoPlayBadge({ size = "md" }: { size?: "sm" | "md" }) {
  const cls =
    size === "sm"
      ? "h-7 w-7"
      : "h-10 w-10";
  const ic = size === "sm" ? "h-3 w-3" : "h-4 w-4";
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className={`${cls} rounded-full bg-black/55 text-white flex items-center justify-center shadow backdrop-blur-sm`}>
        <Play className={`${ic} fill-current ml-0.5`} />
      </div>
    </div>
  );
}

function PairMedia({
  photo,
  className,
  testId,
  controls = false,
}: {
  photo: PairWithPhotos["leftPhoto"];
  className?: string;
  testId?: string;
  controls?: boolean;
}) {
  if (photo.resourceType === "video") {
    return (
      <video
        src={photoUrl(photo)}
        poster={photoThumbUrl(photo)}
        controls={controls}
        playsInline
        className={className}
        data-testid={testId}
      />
    );
  }
  return (
    <img
      src={photoUrl(photo)}
      alt={photo.originalName}
      className={className}
      draggable={false}
      data-testid={testId}
    />
  );
}

// -------- Pair card in the grid (side-by-side preview) --------

export function PairCard({
  pair,
  onOpen,
  onRename,
  onMove,
  onDelete,
}: {
  pair: PairWithPhotos;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group relative aspect-square"
      data-testid={`pair-card-${pair.id}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 w-full h-full focus:outline-none rounded-lg"
        aria-label={`Open pair${pair.name ? ` ${pair.name}` : ""}`}
        data-testid={`button-open-pair-${pair.id}`}
      >
        {/* Back card (right photo) — offset & rotated to peek out from behind */}
        <div className="absolute inset-1.5 rounded-lg overflow-hidden bg-muted shadow-md ring-1 ring-black/10 dark:ring-white/10 transform rotate-[4deg] translate-x-1 translate-y-1 transition-transform duration-200 group-hover:rotate-[6deg] group-hover:translate-x-1.5 group-hover:translate-y-1.5">
          <img
            src={photoThumbUrl(pair.rightPhoto)}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover"
            loading="lazy"
            draggable={false}
          />
          {pair.rightPhoto.resourceType === "video" && <VideoPlayBadge size="sm" />}
        </div>

        {/* Front card (left photo) — sits on top */}
        <div className="absolute inset-0 rounded-lg overflow-hidden bg-muted shadow-lg ring-1 ring-black/10 dark:ring-white/10 transform transition-transform duration-200 group-hover:-rotate-[2deg] group-hover:-translate-x-0.5 group-hover:-translate-y-0.5 hover-elevate">
          <img
            src={photoThumbUrl(pair.leftPhoto)}
            alt={pair.leftPhoto.originalName}
            className="w-full h-full object-cover"
            loading="lazy"
            draggable={false}
          />
          {pair.leftPhoto.resourceType === "video" && <VideoPlayBadge size="md" />}

          {/* Pair badge */}
          <div className="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/55 backdrop-blur-sm px-2 py-1 text-[11px] font-medium text-white">
            <Columns2 className="h-3 w-3" />
            Pair
          </div>

          {/* Label gradient */}
          {pair.name && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
              <p
                className="text-xs text-white truncate"
                data-testid={`text-pair-name-${pair.id}`}
              >
                {pair.name}
              </p>
            </div>
          )}
        </div>
      </button>

      {/* Actions — kept above the stack so they remain clickable */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-black/55 backdrop-blur-sm text-white hover:bg-black/75 transition-colors"
          aria-label="Rename pair"
          data-testid={`button-rename-pair-${pair.id}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMove();
          }}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-black/55 backdrop-blur-sm text-white hover:bg-black/75 transition-colors"
          aria-label="Move pair to folder"
          data-testid={`button-move-pair-${pair.id}`}
        >
          <FolderInput className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-black/55 backdrop-blur-sm text-white hover:bg-red-600/80 transition-colors"
          aria-label="Delete pair"
          data-testid={`button-delete-pair-${pair.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// -------- Pair lightbox with side-by-side / slider toggle --------

type PairViewMode = "side" | "slider";

export function PairLightbox({
  pair,
  onClose,
  onPrev,
  onNext,
  onMove,
}: {
  pair: PairWithPhotos;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onMove?: () => void;
}) {
  const [mode, setMode] = useState<PairViewMode>("side");
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "s" || e.key === "S")
        setMode((m) => (m === "side" ? "slider" : "side"));
      else if (e.key === "ArrowLeft" && onPrev) onPrev();
      else if (e.key === "ArrowRight" && onNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  // Swipe handler for outside-of-image area (background): horizontal swipe = navigate pairs.
  const onSwipeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    swipeStartRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const onSwipeEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      // Require mostly-horizontal motion of at least 50px to count as a swipe.
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      if (dx > 0 && onPrev) onPrev();
      else if (dx < 0 && onNext) onNext();
    },
    [onPrev, onNext]
  );

  return (
    <div
      className="fixed inset-0 z-40 bg-black/90 backdrop-blur-sm flex flex-col"
      data-testid="pair-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={pair.name ?? "Photo pair"}
      onPointerDown={onSwipeStart}
      onPointerUp={onSwipeEnd}
      onPointerCancel={() => (swipeStartRef.current = null)}
    >
      <div className="flex items-center gap-2 p-3 sm:p-4 text-white">
        <div className="min-w-0 flex-1">
          <p
            className="text-sm font-medium truncate"
            data-testid="text-pair-lightbox-name"
          >
            {pair.name ?? `${pair.leftPhoto.originalName} · ${pair.rightPhoto.originalName}`}
          </p>
          <p className="text-xs text-white/65">Pair · 2 photos</p>
        </div>

        {/* View mode toggle */}
        <div
          className="inline-flex items-center rounded-md bg-white/10 p-0.5"
          role="tablist"
          aria-label="Pair view mode"
        >
          <button
            type="button"
            onClick={() => setMode("side")}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
              mode === "side"
                ? "bg-white text-black"
                : "text-white hover:bg-white/10"
            }`}
            role="tab"
            aria-selected={mode === "side"}
            data-testid="button-mode-side"
          >
            <Columns2 className="h-3.5 w-3.5" />
            Side-by-side
          </button>
          <button
            type="button"
            onClick={() => setMode("slider")}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
              mode === "slider"
                ? "bg-white text-black"
                : "text-white hover:bg-white/10"
            }`}
            role="tab"
            aria-selected={mode === "slider"}
            data-testid="button-mode-slider"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Slider
          </button>
        </div>

        {onMove && (
          <button
            type="button"
            onClick={onMove}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md text-white hover:bg-white/10 transition-colors"
            aria-label="Move pair to folder"
            data-testid="button-move-pair-lightbox"
          >
            <FolderInput className="h-4 w-4" />
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center h-9 w-9 rounded-md text-white hover:bg-white/10 transition-colors"
          aria-label="Close"
          data-testid="button-close-pair-lightbox"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 relative flex items-center justify-center px-2 sm:px-4 pb-2">
        {mode === "side" ? (
          <SideBySideView pair={pair} />
        ) : (
          <SliderView pair={pair} />
        )}
      </div>

      {/* Prev / Next bottom bar */}
      {(onPrev || onNext) && (
        <div className="flex items-center justify-center gap-3 pb-3 sm:pb-4 text-white">
          <button
            type="button"
            onClick={onPrev}
            disabled={!onPrev}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 disabled:cursor-not-allowed transition-colors text-sm"
            aria-label="Previous pair"
            data-testid="button-prev-pair"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!onNext}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 disabled:cursor-not-allowed transition-colors text-sm"
            aria-label="Next pair"
            data-testid="button-next-pair"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function SideBySideView({ pair }: { pair: PairWithPhotos }) {
  return (
    <div
      className="w-full h-full flex flex-col sm:flex-row items-stretch justify-center gap-2 sm:gap-3"
      data-testid="pair-view-side"
    >
      <div className="flex-1 min-h-0 relative flex items-center justify-center">
        <PairMedia
          photo={pair.leftPhoto}
          controls
          className="max-w-full max-h-full object-contain select-none"
          testId="img-pair-left"
        />
      </div>
      <div className="flex-1 min-h-0 relative flex items-center justify-center">
        <PairMedia
          photo={pair.rightPhoto}
          controls
          className="max-w-full max-h-full object-contain select-none"
          testId="img-pair-right"
        />
      </div>
    </div>
  );
}

function SliderView({ pair }: { pair: PairWithPhotos }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(50);
  const draggingRef = useRef(false);

  const setFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const next = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setPct(next);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      draggingRef.current = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setFromClientX(e.clientX);
    },
    [setFromClientX]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setFromClientX(e.clientX);
    },
    [setFromClientX]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    draggingRef.current = false;
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden rounded-md select-none touch-none cursor-ew-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-testid="pair-view-slider"
    >
      {/* Right photo as the base layer */}
      <PairMedia
        photo={pair.rightPhoto}
        className="absolute inset-0 w-full h-full object-contain bg-black pointer-events-none"
      />
      {/* Left photo clipped to pct */}
      <div
        className="absolute inset-0 overflow-hidden pointer-events-none"
        style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
      >
        <PairMedia
          photo={pair.leftPhoto}
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />
      </div>
      {/* Divider + handle */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.6)] pointer-events-none"
        style={{ left: `${pct}%`, transform: "translateX(-50%)" }}
      />
      <div
        className="absolute top-1/2 h-9 w-9 rounded-full bg-white shadow-lg flex items-center justify-center pointer-events-none"
        style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
      >
        <ArrowLeftRight className="h-4 w-4 text-black" />
      </div>
      {/* Labels */}
      <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/55 text-white text-xs pointer-events-none">
        {pair.leftPhoto.originalName}
      </div>
      <div className="absolute top-2 right-2 px-2 py-1 rounded bg-black/55 text-white text-xs pointer-events-none">
        {pair.rightPhoto.originalName}
      </div>
    </div>
  );
}
