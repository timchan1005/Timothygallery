import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search,
  ScanText,
  X,
  ZoomIn,
  ZoomOut,
  FileText,
  FileSpreadsheet,
  FileType2,
} from "lucide-react";

// Lazy imports so we don't pay the cost unless the viewer opens
// pdfjs-dist v4 ships ESM only — we import the legacy build for broadest compatibility.
import * as pdfjsLib from "pdfjs-dist";
// @ts-expect-error — vite handles ?url
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface DocumentLite {
  id: number;
  originalName: string;
  docType: "pdf" | "docx" | "docm" | "xlsx" | "xlsm" | "other";
  url?: string;
  downloadUrl?: string;
  size: number;
}

export function DocumentViewer({
  doc,
  onClose,
}: {
  doc: DocumentLite | null;
  onClose: () => void;
}) {
  const open = doc !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(96vw,1200px)] h-[92vh] p-0 gap-0 overflow-hidden flex flex-col">
        {doc && <ViewerBody doc={doc} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ViewerBody({ doc, onClose }: { doc: DocumentLite; onClose: () => void }) {
  const Icon =
    doc.docType === "pdf"
      ? FileText
      : doc.docType === "xlsx" || doc.docType === "xlsm"
        ? FileSpreadsheet
        : FileType2;

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
        <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate" data-testid="text-doc-name">
            {doc.originalName}
          </p>
          <p className="text-xs text-muted-foreground">
            {doc.docType.toUpperCase()} · {formatBytes(doc.size)}
          </p>
        </div>
        {doc.downloadUrl && (
          <Button
            asChild
            size="sm"
            variant="outline"
            className="gap-1.5"
            data-testid="button-doc-download"
          >
            <a href={doc.downloadUrl} download>
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label="Close viewer"
          data-testid="button-doc-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {doc.docType === "pdf" && <PdfViewer doc={doc} />}
        {(doc.docType === "docx" || doc.docType === "docm") && <DocxViewer doc={doc} />}
        {(doc.docType === "xlsx" || doc.docType === "xlsm") && <XlsxViewer doc={doc} />}
        {doc.docType === "other" && (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Preview not available for this file type.
          </div>
        )}
      </div>
    </>
  );
}

/* ----------------------------- PDF ----------------------------- */

function PdfViewer({ doc }: { doc: DocumentLite }) {
  const [pdf, setPdf] = useState<any>(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string>("");
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrLang, setOcrLang] = useState<"eng" | "chi_tra" | "chi_sim" | "chi_tra+eng" | "chi_sim+eng">("chi_tra+eng");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<any>(null);

  // Load the PDF
  useEffect(() => {
    let cancelled = false;
    if (!doc.url) return;
    setError(null);
    setPageNum(1);
    setPageCount(0);
    setOcrText("");
    setOcrProgress(null);
    pdfjsLib
      .getDocument({ url: doc.url, withCredentials: false })
      .promise.then((p) => {
        if (cancelled) return;
        setPdf(p);
        setPageCount(p.numPages);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || "Failed to load PDF");
      });
    return () => {
      cancelled = true;
    };
  }, [doc.url]);

  // Render the current page
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    setOcrText("");
    pdf.getPage(pageNum).then((page: any) => {
      if (cancelled) return;
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const baseViewport = page.getViewport({ scale: 1 });
      // Aim for a width around the available content area; clamp to keep canvas size sane.
      const targetWidth = Math.min(
        canvas.parentElement?.clientWidth ?? 800,
        1600
      );
      const scale = (targetWidth / baseViewport.width) * zoom;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      // Cancel any in-flight render before starting a new one
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // ignore
        }
      }
      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      task.promise.catch(() => {
        // render cancelled — fine
      });
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNum, zoom]);

  // OCR the current page
  const runOcr = async () => {
    if (!canvasRef.current || ocrProgress !== null) return;
    try {
      setOcrProgress(0);
      setOcrText("");
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker(ocrLang, 1, {
        logger: (m: any) => {
          if (m.status === "recognizing text") setOcrProgress(Math.round(m.progress * 100));
        },
      });
      // Hand the rendered canvas straight to Tesseract
      const result = await worker.recognize(canvasRef.current);
      setOcrText(result.data.text || "(no text detected)");
      await worker.terminate();
      setOcrProgress(null);
    } catch (e: any) {
      setOcrText(`OCR failed: ${e?.message || e}`);
      setOcrProgress(null);
    }
  };

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-destructive p-6 text-center">
        {error}
      </div>
    );
  }
  if (!pdf) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading PDF…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center flex-wrap gap-2 px-4 py-2 border-b shrink-0 text-sm">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setPageNum((n) => Math.max(1, n - 1))}
          disabled={pageNum <= 1}
          aria-label="Previous page"
          data-testid="button-pdf-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums" data-testid="text-pdf-page">
          {pageNum} / {pageCount}
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setPageNum((n) => Math.min(pageCount, n + 1))}
          disabled={pageNum >= pageCount}
          aria-label="Next page"
          data-testid="button-pdf-next"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        <span className="mx-2 h-4 w-px bg-border" />

        <Button size="icon" variant="ghost" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))} aria-label="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button size="icon" variant="ghost" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))} aria-label="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </Button>

        <span className="mx-2 h-4 w-px bg-border" />

        <Select value={ocrLang} onValueChange={(v) => setOcrLang(v as any)}>
          <SelectTrigger className="h-8 w-[170px]" data-testid="select-ocr-lang">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chi_tra+eng">Traditional Chinese + English</SelectItem>
            <SelectItem value="chi_sim+eng">Simplified Chinese + English</SelectItem>
            <SelectItem value="chi_tra">繁體中文</SelectItem>
            <SelectItem value="chi_sim">简体中文</SelectItem>
            <SelectItem value="eng">English</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="outline"
          onClick={runOcr}
          disabled={ocrProgress !== null}
          className="gap-1.5"
          data-testid="button-pdf-ocr"
        >
          {ocrProgress !== null ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              OCR {ocrProgress}%
            </>
          ) : (
            <>
              <ScanText className="h-3.5 w-3.5" />
              OCR this page
            </>
          )}
        </Button>
      </div>

      {/* Page + OCR side-by-side on wide screens, stacked on narrow */}
      <div className="flex-1 min-h-0 overflow-auto bg-muted/30">
        <div className="flex flex-col xl:flex-row gap-4 p-4 items-start">
          <div className="flex-1 min-w-0 flex justify-center">
            <canvas
              ref={canvasRef}
              className="bg-white shadow-md ring-1 ring-black/10 dark:ring-white/10 rounded"
              data-testid="canvas-pdf-page"
            />
          </div>
          {(ocrText || ocrProgress !== null) && (
            <div className="w-full xl:w-[420px] xl:shrink-0 bg-card border rounded-lg p-3 max-h-[70vh] overflow-auto">
              <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
                <Search className="h-3.5 w-3.5" />
                Extracted text (page {pageNum})
              </div>
              {ocrProgress !== null && ocrText === "" ? (
                <div className="text-xs text-muted-foreground">Reading page… {ocrProgress}%</div>
              ) : (
                <pre className="text-sm whitespace-pre-wrap break-words font-sans leading-relaxed" data-testid="text-ocr-result">
                  {ocrText}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- DOCX ---------------------------- */

function DocxViewer({ doc }: { doc: DocumentLite }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMacro = doc.docType === "docm";

  useEffect(() => {
    let cancelled = false;
    if (!doc.url) return;
    setHtml(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(doc.url!);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (!cancelled) setHtml(result.value || "<p><em>(empty document)</em></p>");
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to render Word document");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.url]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-destructive p-6 text-center">
        {error}
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Rendering document…
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto bg-muted/30">
      <div className="max-w-3xl mx-auto bg-card my-6 px-10 py-12 shadow-sm rounded-lg border">
        {isMacro && (
          <div className="mb-4 text-xs px-3 py-2 rounded bg-yellow-100 dark:bg-yellow-950 text-yellow-900 dark:text-yellow-100 border border-yellow-200 dark:border-yellow-900">
            This is a macro-enabled document (.docm). Macros are not executed in preview — only the document content is shown.
          </div>
        )}
        <div
          className="prose prose-sm max-w-none dark:prose-invert docx-preview"
          dangerouslySetInnerHTML={{ __html: html }}
          data-testid="docx-content"
        />
      </div>
    </div>
  );
}

/* ---------------------------- XLSX ---------------------------- */

function XlsxViewer({ doc }: { doc: DocumentLite }) {
  const [sheets, setSheets] = useState<Array<{ name: string; html: string }> | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const isMacro = doc.docType === "xlsm";

  useEffect(() => {
    let cancelled = false;
    if (!doc.url) return;
    setSheets(null);
    setError(null);
    setActiveSheet(0);
    (async () => {
      try {
        const res = await fetch(doc.url!);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(buf, { type: "array" });
        const out = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const html = XLSX.utils.sheet_to_html(ws, { editable: false });
          return { name, html };
        });
        if (!cancelled) setSheets(out);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to render spreadsheet");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.url]);

  const activeHtml = useMemo(() => sheets?.[activeSheet]?.html ?? "", [sheets, activeSheet]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-destructive p-6 text-center">
        {error}
      </div>
    );
  }
  if (sheets === null) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading workbook…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {(isMacro || sheets.length > 1) && (
        <div className="border-b px-3 py-2 flex items-center gap-1 overflow-x-auto shrink-0">
          {isMacro && (
            <span className="mr-2 text-[11px] px-2 py-0.5 rounded bg-yellow-100 dark:bg-yellow-950 text-yellow-900 dark:text-yellow-100 border border-yellow-200 dark:border-yellow-900 whitespace-nowrap">
              macros not executed
            </span>
          )}
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={`text-xs px-3 py-1 rounded-md whitespace-nowrap ${
                i === activeSheet
                  ? "bg-primary text-primary-foreground"
                  : "hover-elevate text-muted-foreground"
              }`}
              data-testid={`tab-sheet-${i}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto bg-muted/30 p-4">
        <div
          className="xlsx-preview bg-card rounded-lg border shadow-sm inline-block min-w-full"
          dangerouslySetInnerHTML={{ __html: activeHtml }}
          data-testid="xlsx-content"
        />
      </div>
    </div>
  );
}

/* ---------------------------- helpers ---------------------------- */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
