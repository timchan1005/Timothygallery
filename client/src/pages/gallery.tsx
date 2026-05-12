import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, API_BASE, withToken, setAuthToken, getAuthToken, subscribeAuthToken, photoUrl, photoThumbUrl, photoDownloadUrl } from "@/lib/queryClient";
import type { Folder, Photo, PairWithPhotos } from "@shared/schema";
import { PairCard, PairLightbox } from "@/components/pair-views";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  ImagePlus,
  Search,
  Download,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronRight as ChevRight,
  Sun,
  Moon,
  Loader2,
  FolderPlus,
  Folder as FolderIcon,
  FolderOpen,
  Home,
  Pencil,
  FolderInput,
  MoreVertical,
  Columns2,
  Check,
  LogOut,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ---------- helpers ----------

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i;
function isLikelyImage(f: File): boolean {
  // Accept anything with image/* mime, or empty/octet-stream mime + image extension.
  // iOS Safari sometimes hands back empty mime for HEIC photos.
  if (f.type && f.type.startsWith("image/")) return true;
  if (!f.type || f.type === "application/octet-stream") return IMAGE_EXT.test(f.name);
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function useTheme() {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    setIsDark(prefersDark);
  }, []);
  useEffect(() => {
    if (isDark) document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  }, [isDark]);
  return { isDark, toggle: () => setIsDark((v) => !v) };
}

// Tracks current folder via path in the hash (#/folder/12 or #/)
function useCurrentFolderId(): [number | null, (id: number | null) => void] {
  const [folderId, setFolderIdState] = useState<number | null>(() => readFolderFromHash());

  useEffect(() => {
    const onHashChange = () => setFolderIdState(readFolderFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setFolderId = useCallback((id: number | null) => {
    if (id === null) window.location.hash = "#/";
    else window.location.hash = `#/folder/${id}`;
  }, []);

  return [folderId, setFolderId];
}

function readFolderFromHash(): number | null {
  const h = window.location.hash || "";
  // hash is like "#/folder/12" or "#/"
  const path = h.replace(/^#/, "");
  const m = path.match(/^\/folder\/(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <svg
        width="28"
        height="28"
        viewBox="0 0 32 32"
        fill="none"
        aria-label="Lumen logo"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="2" y="6" width="28" height="22" rx="4" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="11" cy="15" r="2.5" fill="currentColor" />
        <path
          d="M4 24 L13 16 L19 21 L22 18 L28 24"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      <span className="text-base font-semibold tracking-tight">Lumen</span>
    </div>
  );
}

// ---------- main component ----------

export default function Gallery() {
  const { toast } = useToast();
  const { isDark, toggle } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [currentFolderId, setCurrentFolderId] = useCurrentFolderId();
  const [isDragging, setIsDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // Pair feature state
  const pairFileInputRef = useRef<HTMLInputElement>(null);
  const [pairingMode, setPairingMode] = useState(false);
  const [selectedForPair, setSelectedForPair] = useState<number[]>([]);
  const [selectedPair, setSelectedPair] = useState<PairWithPhotos | null>(null);
  const [renamePairTarget, setRenamePairTarget] = useState<PairWithPhotos | null>(null);
  const [pendingDeletePair, setPendingDeletePair] = useState<PairWithPhotos | null>(null);

  // Dialog state
  const [pendingDeletePhotoId, setPendingDeletePhotoId] = useState<number | null>(null);
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<Folder | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Folder | null>(null);
  const [moveTarget, setMoveTarget] = useState<
    | { type: "photo"; photo: Photo }
    | { type: "folder"; folder: Folder }
    | null
  >(null);

  // Queries
  const folderKey = ["/api/folders", { parentId: currentFolderId ?? "root" }];
  const photoKey = ["/api/photos", { folderId: currentFolderId ?? "root" }];

  const { data: folders = [], isLoading: foldersLoading } = useQuery<Folder[]>({
    queryKey: folderKey,
    queryFn: async () => {
      const url =
        currentFolderId === null
          ? "/api/folders"
          : `/api/folders?parentId=${currentFolderId}`;
      const r = await apiRequest("GET", url);
      return r.json();
    },
  });

  const { data: photos = [], isLoading: photosLoading } = useQuery<Photo[]>({
    queryKey: photoKey,
    queryFn: async () => {
      const url =
        currentFolderId === null
          ? "/api/photos"
          : `/api/photos?folderId=${currentFolderId}`;
      const r = await apiRequest("GET", url);
      return r.json();
    },
  });

  const pairKey = ["/api/pairs", { folderId: currentFolderId ?? "root" }];
  const { data: pairs = [], isLoading: pairsLoading } = useQuery<PairWithPhotos[]>({
    queryKey: pairKey,
    queryFn: async () => {
      const url =
        currentFolderId === null
          ? "/api/pairs"
          : `/api/pairs?folderId=${currentFolderId}`;
      const r = await apiRequest("GET", url);
      return r.json();
    },
  });

  // Breadcrumb path for current folder
  const { data: breadcrumb = [] } = useQuery<Folder[]>({
    queryKey: ["/api/folders/path", currentFolderId],
    enabled: currentFolderId !== null,
    queryFn: async () => {
      if (currentFolderId === null) return [] as Folder[];
      const r = await apiRequest("GET", `/api/folders/${currentFolderId}/path`);
      return r.json();
    },
  });

  // ---------- mutations ----------

  const uploadMutation = useMutation({
    mutationFn: async (files: FileList | File[]) => {
      const arr = Array.from(files);
      const imgs = arr.filter(isLikelyImage);
      if (imgs.length === 0) throw new Error("No image files selected");
      const fd = new FormData();
      for (const f of imgs) fd.append("files", f);
      if (currentFolderId !== null) fd.append("folderId", String(currentFolderId));
      const res = await apiRequest("POST", "/api/photos", fd);
      return res.json();
    },
    onSuccess: (created: Photo[]) => {
      queryClient.invalidateQueries({ queryKey: ["/api/photos"] });
      toast({
        title: `Uploaded ${created.length} ${created.length === 1 ? "photo" : "photos"}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const createFolderMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/folders", {
        name,
        parentId: currentFolderId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/folders"] });
      setNewFolderOpen(false);
      toast({ title: "Folder created" });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't create folder", description: err.message, variant: "destructive" });
    },
  });

  const renameFolderMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await apiRequest("PATCH", `/api/folders/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/folders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/folders/path"] });
      setRenameTarget(null);
      toast({ title: "Folder renamed" });
    },
    onError: (err: Error) => {
      toast({ title: "Rename failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/folders/${id}`);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/folders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/photos"] });
      toast({ title: "Folder deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const movePhotoMutation = useMutation({
    mutationFn: async ({ id, folderId }: { id: number; folderId: number | null }) => {
      const res = await apiRequest("PATCH", `/api/photos/${id}`, { folderId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/photos"] });
      setMoveTarget(null);
      setSelectedIdx(null);
      toast({ title: "Photo moved" });
    },
    onError: (err: Error) => {
      toast({ title: "Move failed", description: err.message, variant: "destructive" });
    },
  });

  const moveFolderMutation = useMutation({
    mutationFn: async ({ id, parentId }: { id: number; parentId: number | null }) => {
      const res = await apiRequest("PATCH", `/api/folders/${id}`, { parentId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/folders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/folders/path"] });
      setMoveTarget(null);
      toast({ title: "Folder moved" });
    },
    onError: (err: Error) => {
      toast({ title: "Move failed", description: err.message, variant: "destructive" });
    },
  });

  const deletePhotoMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/photos/${id}`);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/photos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pairs"] });
      toast({ title: "Photo deleted" });
      setSelectedIdx(null);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  // ---- Pair mutations ----
  const uploadPairMutation = useMutation({
    mutationFn: async (files: FileList | File[]) => {
      const arr = Array.from(files).filter(isLikelyImage);
      if (arr.length !== 2) throw new Error("Please select exactly two image files");
      const fd = new FormData();
      fd.append("files", arr[0]);
      fd.append("files", arr[1]);
      if (currentFolderId !== null) fd.append("folderId", String(currentFolderId));
      const res = await apiRequest("POST", "/api/pairs/upload", fd);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pairs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/photos"] });
      toast({ title: "Pair uploaded" });
    },
    onError: (err: Error) => {
      toast({ title: "Pair upload failed", description: err.message, variant: "destructive" });
    },
  });

  const createPairMutation = useMutation({
    mutationFn: async (ids: [number, number]) => {
      const res = await apiRequest("POST", "/api/pairs", {
        leftPhotoId: ids[0],
        rightPhotoId: ids[1],
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pairs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/photos"] });
      setPairingMode(false);
      setSelectedForPair([]);
      toast({ title: "Photos paired" });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't pair", description: err.message, variant: "destructive" });
    },
  });

  const renamePairMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string | null }) => {
      const res = await apiRequest("PATCH", `/api/pairs/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pairs"] });
      setRenamePairTarget(null);
      toast({ title: "Pair renamed" });
    },
    onError: (err: Error) => {
      toast({ title: "Rename failed", description: err.message, variant: "destructive" });
    },
  });

  const deletePairMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/pairs/${id}`);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pairs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/photos"] });
      setSelectedPair(null);
      toast({ title: "Pair deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  // ---------- drag-drop on whole window ----------

  useEffect(() => {
    let dragCounter = 0;
    const onEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        dragCounter++;
        setIsDragging(true);
      }
    };
    const onLeave = () => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        setIsDragging(false);
      }
    };
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setIsDragging(false);
      if (e.dataTransfer?.files?.length) uploadMutation.mutate(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [uploadMutation]);

  // ---------- filtering & selection ----------

  const q = query.trim().toLowerCase();
  const filteredFolders = useMemo(() => {
    if (!q) return folders;
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, q]);

  const filteredPhotos = useMemo(() => {
    if (!q) return photos;
    return photos.filter((p) => p.originalName.toLowerCase().includes(q));
  }, [photos, q]);

  const filteredPairs = useMemo(() => {
    if (!q) return pairs;
    return pairs.filter((p) => {
      const hay = [
        p.name ?? "",
        p.leftPhoto.originalName,
        p.rightPhoto.originalName,
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [pairs, q]);

  const selectedPhoto =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < filteredPhotos.length
      ? filteredPhotos[selectedIdx]
      : null;

  // Lightbox keyboard nav
  useEffect(() => {
    if (selectedIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedIdx(null);
      else if (e.key === "ArrowLeft")
        setSelectedIdx((i) => (i === null ? null : Math.max(0, i - 1)));
      else if (e.key === "ArrowRight")
        setSelectedIdx((i) =>
          i === null ? null : Math.min(filteredPhotos.length - 1, i + 1)
        );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIdx, filteredPhotos.length]);

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const isLoading = foldersLoading || photosLoading || pairsLoading;
  const isEmpty =
    !isLoading &&
    filteredFolders.length === 0 &&
    filteredPhotos.length === 0 &&
    filteredPairs.length === 0;
  const isEmptyNoSearch =
    isEmpty && !q && folders.length === 0 && photos.length === 0 && pairs.length === 0;
  const isEmptyButFiltered =
    isEmpty && q && (folders.length > 0 || photos.length > 0 || pairs.length > 0);
  const currentFolderName =
    breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].name : "All photos";

  // ---------- render ----------

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            data-testid="button-home"
            aria-label="Go to root folder"
          >
            <Logo />
          </button>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search this folder"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8 h-9 w-56"
                data-testid="input-search"
              />
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
              data-testid="button-theme-toggle"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>

            <Button
              variant="outline"
              onClick={() => setNewFolderOpen(true)}
              data-testid="button-new-folder"
              className="gap-2"
            >
              <FolderPlus className="h-4 w-4" />
              <span className="hidden sm:inline">New folder</span>
            </Button>

            <Button
              variant="outline"
              onClick={() => pairFileInputRef.current?.click()}
              disabled={uploadPairMutation.isPending}
              data-testid="button-upload-pair"
              className="gap-2"
              title="Upload two photos as a pair"
            >
              {uploadPairMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Columns2 className="h-4 w-4" />
              )}
              <span className="hidden md:inline">Upload pair</span>
            </Button>

            <Button
              onClick={onPickFiles}
              disabled={uploadMutation.isPending}
              data-testid="button-upload"
              className="gap-2"
            >
              {uploadMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">Upload</span>
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={async () => {
                const token = getAuthToken();
                try {
                  if (token) {
                    await fetch(`${API_BASE}/api/auth/logout`, {
                      method: "POST",
                      headers: { Authorization: `Bearer ${token}` },
                    });
                  }
                } catch {
                  // ignore network errors on logout
                }
                setAuthToken(null);
                queryClient.clear();
              }}
              data-testid="button-logout"
              aria-label="Lock"
              title="Lock"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Mobile search row */}
        <div className="sm:hidden px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search this folder"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8 h-9"
              data-testid="input-search-mobile"
            />
          </div>
        </div>
      </header>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            uploadMutation.mutate(Array.from(e.target.files));
          }
          e.target.value = "";
        }}
        data-testid="input-file"
      />

      {/* Hidden pair file input (multiple, exactly 2 expected) */}
      <input
        ref={pairFileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            if (files.length !== 2) {
              toast({
                title: "Please pick exactly two photos",
                description: `You selected ${files.length}. A pair needs two photos.`,
                variant: "destructive",
              });
            } else {
              uploadPairMutation.mutate(Array.from(files));
            }
          }
          e.target.value = "";
        }}
        data-testid="input-pair-file"
      />

      {/* Body */}
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-5 sm:py-6">
          {/* Breadcrumb */}
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1 text-sm mb-4 flex-wrap"
            data-testid="breadcrumb"
          >
            <button
              type="button"
              onClick={() => setCurrentFolderId(null)}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover-elevate"
              data-testid="crumb-root"
            >
              <Home className="h-3.5 w-3.5" />
              <span>My library</span>
            </button>
            {breadcrumb.map((f, idx) => {
              const isLast = idx === breadcrumb.length - 1;
              return (
                <span key={f.id} className="inline-flex items-center gap-1">
                  <ChevRight className="h-3.5 w-3.5 text-muted-foreground" />
                  {isLast ? (
                    <span
                      className="px-2 py-1 font-medium"
                      data-testid={`crumb-current-${f.id}`}
                    >
                      {f.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCurrentFolderId(f.id)}
                      className="px-2 py-1 rounded-md hover-elevate"
                      data-testid={`crumb-${f.id}`}
                    >
                      {f.name}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>

          {/* Title row */}
          <div className="mb-5 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-baseline gap-2">
              <h1
                className="text-xl font-semibold tracking-tight"
                data-testid="text-page-title"
              >
                {q ? "Search" : currentFolderName}
              </h1>
              <span className="text-sm text-muted-foreground" data-testid="text-photo-count">
                {[
                  filteredFolders.length > 0
                    ? `${filteredFolders.length} ${filteredFolders.length === 1 ? "folder" : "folders"}`
                    : null,
                  filteredPairs.length > 0
                    ? `${filteredPairs.length} ${filteredPairs.length === 1 ? "pair" : "pairs"}`
                    : null,
                  filteredPhotos.length > 0
                    ? `${filteredPhotos.length} ${filteredPhotos.length === 1 ? "photo" : "photos"}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {filteredPhotos.length >= 2 && (
              <Button
                variant={pairingMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setPairingMode((v) => !v);
                  setSelectedForPair([]);
                }}
                className="gap-1.5"
                data-testid="button-toggle-pairing-mode"
              >
                <Columns2 className="h-3.5 w-3.5" />
                {pairingMode ? "Cancel pairing" : "Pair photos"}
              </Button>
            )}
          </div>

          {/* Pairing mode banner */}
          {pairingMode && (
            <div
              className="mb-4 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
              data-testid="pairing-banner"
            >
              <Columns2 className="h-4 w-4 text-primary shrink-0" />
              <p className="text-sm flex-1">
                {selectedForPair.length === 0
                  ? "Select two photos to pair them together."
                  : selectedForPair.length === 1
                  ? "One photo selected. Pick one more."
                  : "Two photos selected. Create the pair?"}
              </p>
              <Button
                size="sm"
                onClick={() => {
                  if (selectedForPair.length === 2) {
                    createPairMutation.mutate([
                      selectedForPair[0],
                      selectedForPair[1],
                    ]);
                  }
                }}
                disabled={
                  selectedForPair.length !== 2 || createPairMutation.isPending
                }
                data-testid="button-create-pair"
              >
                {createPairMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span className="ml-1">Create pair</span>
              </Button>
            </div>
          )}

          {/* Loading state */}
          {isLoading && (
            <div className="gallery-grid" data-testid="loading-skeletons">
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-square rounded-lg bg-muted animate-pulse"
                />
              ))}
            </div>
          )}

          {/* Folders section */}
          {!isLoading && filteredFolders.length > 0 && (
            <section className="mb-7" data-testid="folders-section">
              <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-3">
                Folders
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {filteredFolders.map((folder) => (
                  <FolderCard
                    key={folder.id}
                    folder={folder}
                    onOpen={() => setCurrentFolderId(folder.id)}
                    onRename={() => setRenameTarget(folder)}
                    onMove={() => setMoveTarget({ type: "folder", folder })}
                    onDelete={() => setPendingDeleteFolder(folder)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Pairs section */}
          {!isLoading && filteredPairs.length > 0 && (
            <section className="mb-7" data-testid="pairs-section">
              <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-3">
                Pairs
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5 auto-rows-min">
                {filteredPairs.map((pair) => (
                  <PairCard
                    key={pair.id}
                    pair={pair}
                    onOpen={() => setSelectedPair(pair)}
                    onRename={() => setRenamePairTarget(pair)}
                    onDelete={() => setPendingDeletePair(pair)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Photos section */}
          {!isLoading && filteredPhotos.length > 0 && (
            <section data-testid="photos-section">
              {(filteredFolders.length > 0 || filteredPairs.length > 0) && (
                <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-3">
                  Photos
                </h2>
              )}
              <div className="gallery-grid" data-testid="gallery-grid">
                {filteredPhotos.map((photo, idx) => {
                  const isSelectedForPair = selectedForPair.includes(photo.id);
                  return (
                    <button
                      key={photo.id}
                      onClick={() => {
                        if (pairingMode) {
                          setSelectedForPair((prev) => {
                            if (prev.includes(photo.id)) {
                              return prev.filter((x) => x !== photo.id);
                            }
                            if (prev.length >= 2) {
                              // replace oldest selection
                              return [prev[1], photo.id];
                            }
                            return [...prev, photo.id];
                          });
                        } else {
                          setSelectedIdx(idx);
                        }
                      }}
                      className={`group relative aspect-square overflow-hidden rounded-lg bg-muted hover-elevate focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                        pairingMode && isSelectedForPair
                          ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                          : ""
                      }`}
                      data-testid={`button-photo-${photo.id}`}
                      aria-label={
                        pairingMode
                          ? `${isSelectedForPair ? "Deselect" : "Select"} ${photo.originalName} for pairing`
                          : `Open ${photo.originalName}`
                      }
                      aria-pressed={pairingMode ? isSelectedForPair : undefined}
                    >
                      <img
                        src={photoThumbUrl(photo)}
                        alt={photo.originalName}
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                      {pairingMode && isSelectedForPair && (
                        <div
                          className="absolute top-2 right-2 h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold shadow"
                          data-testid={`pair-selection-badge-${photo.id}`}
                        >
                          {selectedForPair.indexOf(photo.id) + 1}
                        </div>
                      )}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/55 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                        <p
                          className="text-xs text-white truncate"
                          data-testid={`text-name-${photo.id}`}
                        >
                          {photo.originalName}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Empty: no items and no search */}
          {isEmptyNoSearch && (
            <div
              onClick={onPickFiles}
              className="border-2 border-dashed border-border rounded-xl p-12 sm:p-20 text-center hover-elevate cursor-pointer transition-colors"
              data-testid="empty-state"
            >
              <div className="mx-auto w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
                <ImagePlus className="h-6 w-6 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-medium mb-1">
                {currentFolderId === null
                  ? "Your library is empty"
                  : "This folder is empty"}
              </h2>
              <p className="text-sm text-muted-foreground mb-5 max-w-sm mx-auto">
                Drop images anywhere on this page, or click to choose files from your
                computer.
              </p>
              <div className="flex flex-wrap gap-2 justify-center">
                <Button variant="default" className="gap-2">
                  <Upload className="h-4 w-4" />
                  Upload photos
                </Button>
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewFolderOpen(true);
                  }}
                >
                  <FolderPlus className="h-4 w-4" />
                  New folder
                </Button>
              </div>
            </div>
          )}

          {/* Empty: search returned no matches but folder had content */}
          {isEmptyButFiltered && (
            <div className="text-center py-16" data-testid="no-results">
              <div className="mx-auto w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-medium mb-1">No matches</h2>
              <p className="text-sm text-muted-foreground">
                Nothing in this folder matches “{query}”.
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      {!isLoading && (folders.length > 0 || photos.length > 0) && (
        <footer className="border-t mt-auto">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 h-12 flex items-center justify-between text-xs text-muted-foreground">
            <span>Tip: drop images anywhere on this page to upload here.</span>
            <span className="hidden sm:inline">
              {photos.length > 0 &&
                `${formatBytes(photos.reduce((s, p) => s + p.size, 0))} in this folder`}
            </span>
          </div>
        </footer>
      )}

      {/* Full-window drag overlay */}
      {isDragging && (
        <div
          className="fixed inset-0 z-50 bg-background/85 backdrop-blur-sm flex items-center justify-center pointer-events-none"
          data-testid="drag-overlay"
        >
          <div className="border-2 border-dashed border-primary rounded-2xl p-10 sm:p-16 text-center max-w-md mx-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <ImagePlus className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Drop to upload</h3>
            <p className="text-sm text-muted-foreground">
              Release anywhere to upload to{" "}
              <span className="font-medium">{currentFolderName}</span>.
            </p>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {selectedPhoto && (
        <div
          className="fixed inset-0 z-40 bg-black/90 backdrop-blur-sm flex flex-col"
          data-testid="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={selectedPhoto.originalName}
        >
          <div className="flex items-center gap-2 p-3 sm:p-4 text-white">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate" data-testid="text-lightbox-name">
                {selectedPhoto.originalName}
              </p>
              <p className="text-xs text-white/65" data-testid="text-lightbox-meta">
                {formatDate(selectedPhoto.uploadedAt)} · {formatBytes(selectedPhoto.size)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setMoveTarget({ type: "photo", photo: selectedPhoto })}
              className="inline-flex items-center justify-center h-9 w-9 rounded-md text-white hover:bg-white/10 transition-colors"
              aria-label="Move to folder"
              data-testid="button-move-photo"
            >
              <FolderInput className="h-4 w-4" />
            </button>
            <a
              href={photoDownloadUrl(selectedPhoto)}
              target="_self"
              rel="noopener"
              className="inline-flex items-center justify-center h-9 w-9 rounded-md text-white hover:bg-white/10 transition-colors"
              aria-label="Download"
              data-testid="button-download"
            >
              <Download className="h-4 w-4" />
            </a>
            <button
              type="button"
              onClick={() => setPendingDeletePhotoId(selectedPhoto.id)}
              className="inline-flex items-center justify-center h-9 w-9 rounded-md text-white hover:bg-white/10 transition-colors"
              aria-label="Delete"
              data-testid="button-delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setSelectedIdx(null)}
              className="inline-flex items-center justify-center h-9 w-9 rounded-md text-white hover:bg-white/10 transition-colors"
              aria-label="Close"
              data-testid="button-close-lightbox"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 relative flex items-center justify-center px-2 sm:px-4 pb-4">
            <img
              key={selectedPhoto.id}
              src={photoUrl(selectedPhoto)}
              alt={selectedPhoto.originalName}
              className="max-w-full max-h-full object-contain select-none"
              data-testid="img-lightbox"
            />

            {selectedIdx !== null && selectedIdx > 0 && (
              <button
                type="button"
                onClick={() =>
                  setSelectedIdx((i) => (i === null ? null : Math.max(0, i - 1)))
                }
                className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
                aria-label="Previous"
                data-testid="button-prev"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            {selectedIdx !== null && selectedIdx < filteredPhotos.length - 1 && (
              <button
                type="button"
                onClick={() =>
                  setSelectedIdx((i) =>
                    i === null ? null : Math.min(filteredPhotos.length - 1, i + 1)
                  )
                }
                className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
                aria-label="Next"
                data-testid="button-next"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Delete photo confirmation */}
      <AlertDialog
        open={pendingDeletePhotoId !== null}
        onOpenChange={(open) => !open && setPendingDeletePhotoId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this photo?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the image from your library. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeletePhotoId !== null) {
                  deletePhotoMutation.mutate(pendingDeletePhotoId);
                }
                setPendingDeletePhotoId(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete folder confirmation */}
      <AlertDialog
        open={pendingDeleteFolder !== null}
        onOpenChange={(open) => !open && setPendingDeleteFolder(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{pendingDeleteFolder?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the folder and{" "}
              <span className="font-medium">everything inside it</span> — all
              subfolders and photos. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-folder">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteFolder)
                  deleteFolderMutation.mutate(pendingDeleteFolder.id);
                setPendingDeleteFolder(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-folder"
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* New folder dialog */}
      <NewFolderDialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        onCreate={(name) => createFolderMutation.mutate(name)}
        isPending={createFolderMutation.isPending}
        parentName={currentFolderName}
      />

      {/* Rename folder dialog */}
      <RenameFolderDialog
        folder={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRename={(id, name) => renameFolderMutation.mutate({ id, name })}
        isPending={renameFolderMutation.isPending}
      />

      {/* Move dialog */}
      <MoveDialog
        target={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMovePhoto={(photoId, folderId) =>
          movePhotoMutation.mutate({ id: photoId, folderId })
        }
        onMoveFolder={(folderId, parentId) =>
          moveFolderMutation.mutate({ id: folderId, parentId })
        }
        isPending={movePhotoMutation.isPending || moveFolderMutation.isPending}
      />

      {/* Pair lightbox */}
      {selectedPair && (() => {
        const idx = filteredPairs.findIndex((p) => p.id === selectedPair.id);
        const prevPair = idx > 0 ? filteredPairs[idx - 1] : null;
        const nextPair = idx >= 0 && idx < filteredPairs.length - 1 ? filteredPairs[idx + 1] : null;
        return (
          <PairLightbox
            pair={selectedPair}
            onClose={() => setSelectedPair(null)}
            onPrev={prevPair ? () => setSelectedPair(prevPair) : undefined}
            onNext={nextPair ? () => setSelectedPair(nextPair) : undefined}
          />
        );
      })()}

      {/* Rename pair dialog */}
      <RenamePairDialog
        pair={renamePairTarget}
        onClose={() => setRenamePairTarget(null)}
        onRename={(id, name) => renamePairMutation.mutate({ id, name })}
        isPending={renamePairMutation.isPending}
      />

      {/* Delete pair confirmation */}
      <AlertDialog
        open={pendingDeletePair !== null}
        onOpenChange={(open) => !open && setPendingDeletePair(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this pair?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the pair and both photos inside it.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-pair">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeletePair)
                  deletePairMutation.mutate(pendingDeletePair.id);
                setPendingDeletePair(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-pair"
            >
              Delete pair
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------- rename pair dialog ----------

function RenamePairDialog({
  pair,
  onClose,
  onRename,
  isPending,
}: {
  pair: PairWithPhotos | null;
  onClose: () => void;
  onRename: (id: number, name: string | null) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (pair) setName(pair.name ?? "");
  }, [pair]);

  const submit = () => {
    if (!pair) return;
    const trimmed = name.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === (pair.name ?? null)) {
      onClose();
      return;
    }
    onRename(pair.id, next);
  };

  return (
    <Dialog open={pair !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename pair</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="rename-pair-name">Pair name (optional)</Label>
          <Input
            id="rename-pair-name"
            value={name}
            autoFocus
            placeholder="Leave blank to clear"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={80}
            data-testid="input-rename-pair"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            data-testid="button-cancel-rename-pair"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending}
            data-testid="button-confirm-rename-pair"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- folder card ----------

function FolderCard({
  folder,
  onOpen,
  onRename,
  onMove,
  onDelete,
}: {
  folder: Folder;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group relative border border-card-border rounded-lg bg-card hover-elevate"
      data-testid={`folder-${folder.id}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-3 p-3 text-left"
        data-testid={`button-open-folder-${folder.id}`}
        aria-label={`Open ${folder.name}`}
      >
        <div className="flex-shrink-0 w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center">
          <FolderIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="text-sm font-medium truncate"
            data-testid={`text-folder-name-${folder.id}`}
          >
            {folder.name}
          </p>
          <p className="text-xs text-muted-foreground">Folder</p>
        </div>
      </button>

      <div className="absolute top-1.5 right-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              aria-label={`Actions for ${folder.name}`}
              data-testid={`button-folder-menu-${folder.id}`}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={onOpen} data-testid={`menu-open-${folder.id}`}>
              <FolderOpen className="h-4 w-4 mr-2" />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onRename}
              data-testid={`menu-rename-${folder.id}`}
            >
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onMove} data-testid={`menu-move-${folder.id}`}>
              <FolderInput className="h-4 w-4 mr-2" />
              Move
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
              data-testid={`menu-delete-${folder.id}`}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------- new folder dialog ----------

function NewFolderDialog({
  open,
  onClose,
  onCreate,
  isPending,
  parentName,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
  isPending: boolean;
  parentName: string;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>
            Create a folder inside <span className="font-medium">{parentName}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="new-folder-name">Folder name</Label>
          <Input
            id="new-folder-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Untitled folder"
            maxLength={80}
            data-testid="input-folder-name"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            data-testid="button-cancel-new-folder"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending || !name.trim()}
            data-testid="button-create-folder"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- rename folder dialog ----------

function RenameFolderDialog({
  folder,
  onClose,
  onRename,
  isPending,
}: {
  folder: Folder | null;
  onClose: () => void;
  onRename: (id: number, name: string) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (folder) setName(folder.name);
  }, [folder]);

  const submit = () => {
    if (!folder) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === folder.name) {
      onClose();
      return;
    }
    onRename(folder.id, trimmed);
  };

  return (
    <Dialog open={folder !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename folder</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="rename-folder-name">Folder name</Label>
          <Input
            id="rename-folder-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={80}
            data-testid="input-rename-folder"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            data-testid="button-cancel-rename"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending || !name.trim()}
            data-testid="button-confirm-rename"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- move dialog ----------

type FolderNode = Folder & { children: FolderNode[] };

function buildFolderTree(all: Folder[]): FolderNode[] {
  const byParent = new Map<number | null, Folder[]>();
  for (const f of all) {
    const key = f.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(f);
  }
  const attach = (parentId: number | null): FolderNode[] => {
    const list = byParent.get(parentId) || [];
    return list
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ ...f, children: attach(f.id) }));
  };
  return attach(null);
}

function MoveDialog({
  target,
  onClose,
  onMovePhoto,
  onMoveFolder,
  isPending,
}: {
  target:
    | { type: "photo"; photo: Photo }
    | { type: "folder"; folder: Folder }
    | null;
  onClose: () => void;
  onMovePhoto: (photoId: number, folderId: number | null) => void;
  onMoveFolder: (folderId: number, parentId: number | null) => void;
  isPending: boolean;
}) {
  // Load ALL folders so the user can pick any destination
  const { data: allFolders = [] } = useQuery<Folder[]>({
    queryKey: ["/api/folders/all"],
    enabled: target !== null,
    queryFn: async () => {
      // Build by walking from root. Simpler: fetch root, then recurse on each.
      // For simplicity, we list every folder via repeated requests through a quick traversal.
      const collect: Folder[] = [];
      const queue: (number | null)[] = [null];
      const seen = new Set<string>();
      while (queue.length) {
        const pid = queue.shift()!;
        const key = pid === null ? "root" : String(pid);
        if (seen.has(key)) continue;
        seen.add(key);
        const url = pid === null ? "/api/folders" : `/api/folders?parentId=${pid}`;
        const r = await apiRequest("GET", url);
        const list = (await r.json()) as Folder[];
        for (const f of list) {
          collect.push(f);
          queue.push(f.id);
        }
      }
      return collect;
    },
  });

  const tree = useMemo(() => buildFolderTree(allFolders), [allFolders]);

  // Compute disabled set for folder moves: cannot move into itself or its descendants
  const disabledIds = useMemo(() => {
    if (!target || target.type !== "folder") return new Set<number>();
    const result = new Set<number>([target.folder.id]);
    const childrenByParent = new Map<number | null, Folder[]>();
    for (const f of allFolders) {
      const key = f.parentId ?? null;
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key)!.push(f);
    }
    const stack = [target.folder.id];
    while (stack.length) {
      const id = stack.pop()!;
      const kids = childrenByParent.get(id) || [];
      for (const k of kids) {
        if (!result.has(k.id)) {
          result.add(k.id);
          stack.push(k.id);
        }
      }
    }
    return result;
  }, [target, allFolders]);

  const currentParent: number | null =
    target?.type === "photo"
      ? target.photo.folderId
      : target?.type === "folder"
        ? target.folder.parentId
        : null;

  const handlePick = (destId: number | null) => {
    if (!target) return;
    if (destId === currentParent) {
      onClose();
      return;
    }
    if (target.type === "photo") onMovePhoto(target.photo.id, destId);
    else onMoveFolder(target.folder.id, destId);
  };

  const subjectName =
    target?.type === "photo"
      ? target.photo.originalName
      : target?.type === "folder"
        ? target.folder.name
        : "";

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move “{subjectName}”</DialogTitle>
          <DialogDescription>Choose a destination folder.</DialogDescription>
        </DialogHeader>
        <div
          className="max-h-72 overflow-auto -mx-1 px-1"
          data-testid="move-tree"
        >
          <FolderTreeItem
            label="My library"
            icon={<Home className="h-4 w-4" />}
            depth={0}
            isCurrent={currentParent === null}
            disabled={false}
            onPick={() => handlePick(null)}
            testId="move-target-root"
          />
          {tree.map((node) => (
            <FolderTreeBranch
              key={node.id}
              node={node}
              depth={1}
              currentParent={currentParent}
              disabledIds={disabledIds}
              onPick={handlePick}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-move">
            Cancel
          </Button>
          {isPending && <Loader2 className="h-4 w-4 animate-spin self-center" />}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderTreeBranch({
  node,
  depth,
  currentParent,
  disabledIds,
  onPick,
}: {
  node: FolderNode;
  depth: number;
  currentParent: number | null;
  disabledIds: Set<number>;
  onPick: (id: number | null) => void;
}) {
  return (
    <>
      <FolderTreeItem
        label={node.name}
        icon={<FolderIcon className="h-4 w-4" />}
        depth={depth}
        isCurrent={currentParent === node.id}
        disabled={disabledIds.has(node.id)}
        onPick={() => onPick(node.id)}
        testId={`move-target-${node.id}`}
      />
      {node.children.map((c) => (
        <FolderTreeBranch
          key={c.id}
          node={c}
          depth={depth + 1}
          currentParent={currentParent}
          disabledIds={disabledIds}
          onPick={onPick}
        />
      ))}
    </>
  );
}

function FolderTreeItem({
  label,
  icon,
  depth,
  isCurrent,
  disabled,
  onPick,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  depth: number;
  isCurrent: boolean;
  disabled: boolean;
  onPick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded-md text-sm hover-elevate disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      data-testid={testId}
      aria-current={isCurrent}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {isCurrent && (
        <span className="text-xs text-muted-foreground">Current</span>
      )}
    </button>
  );
}
