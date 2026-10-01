import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  Download,
  Loader2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Link, useRouter } from '@/core/i18n/navigation';
import { apiDelete, apiDownload, apiGet } from '@/lib/api-client';
import { saveBlobAsFile } from '@/lib/download';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { artStyleLabel, storybookStyleLabel } from './-storybook-styles';

type StorybookDetail = {
  id: string;
  status: string;
  prompt: string;
  createdAt: string;
  result: {
    title: string;
    pdfUrl?: string;
    textProvider?: string;
    textModel?: string;
    /** Narrative style the story was written in; absent on older books. */
    storyStyle?: string;
    /** Illustration style the pages were drawn in; absent on older books. */
    artStyle?: string;
  } | null;
  progress: { done: number; total: number };
};

function ReaderPage() {
  const { id } = Route.useParams();
  const router = useRouter();

  const query = useQuery({
    queryKey: ['storybook', id],
    queryFn: () => apiGet<StorybookDetail>(`/api/storybooks/${id}`),
    // Generation continues server-side while the reader is open, so keep
    // asking until the book settles.
    refetchInterval: (q) =>
      q.state.data?.status === 'pending' ||
      q.state.data?.status === 'processing'
        ? 5000
        : false,
  });

  const book = query.data;

  // The PDF is already in storage by the time a book is successful, so this is
  // a single download rather than a rebuild.
  const download = useMutation({
    mutationFn: () => apiDownload(`/api/storybooks/${id}/pdf`),
    onSuccess: ({ blob, filename }) => {
      saveBlobAsFile(blob, filename || `storybook-${id}.pdf`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/api/storybooks/${id}`),
    onSuccess: () => {
      toast.success(m['settings.storybooks.deleted']());
      // The book being read no longer exists, so the reader has nothing to
      // show — hand the user back to the library.
      router.push('/settings/storybooks');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Rendered in whichever branch the page ends up in, so a book that is stuck
  // generating or has failed can be deleted without a detour to the library.
  const deleteDialog = (
    <Dialog
      open={confirmingDelete}
      onOpenChange={(isOpen) => {
        if (!isOpen && !deleteMutation.isPending) setConfirmingDelete(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['settings.storybooks.delete_title']()}</DialogTitle>
          <DialogDescription>
            {m['settings.storybooks.delete_description']({
              title: book?.result?.title ?? book?.prompt ?? '',
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={deleteMutation.isPending}
            onClick={() => setConfirmingDelete(false)}
          >
            {m['settings.storybooks.cancel']()}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
          >
            {deleteMutation.isPending
              ? m['settings.storybooks.deleting']()
              : m['settings.storybooks.confirm_delete']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (query.isPending) {
    return (
      <div className="flex items-center justify-center gap-2 p-24">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (!book || !book.result) {
    const failed = book?.status === 'failed';
    const { done, total } = book?.progress ?? { done: 0, total: 0 };
    return (
      <div className="flex flex-col items-center gap-4 p-24 text-center">
        {failed ? (
          <AlertCircle className="text-muted-foreground/40 size-12" />
        ) : (
          <Loader2 className="text-muted-foreground/40 size-12 animate-spin" />
        )}
        <p className="text-muted-foreground">
          {failed
            ? m['settings.storybooks.status_failed']()
            : m['settings.storybooks.reader_not_ready']()}
        </p>
        {!failed && total > 0 && (
          <p className="text-muted-foreground/70 text-sm tabular-nums">
            {m['settings.storybooks.progress']({
              done: String(done),
              total: String(total),
            })}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/settings/storybooks"
            className={cn(buttonVariants({ variant: 'outline' }), 'gap-2')}
          >
            <ArrowLeft className="size-4" />
            {m['settings.storybooks.back_to_library']()}
          </Link>
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-destructive gap-2"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="size-4" />
            {m['settings.storybooks.delete']()}
          </Button>
        </div>
        {deleteDialog}
      </div>
    );
  }

  const builtinStory = book.result.textProvider === 'builtin';
  const style = storybookStyleLabel(book.result.storyStyle);
  const art = artStyleLabel(book.result.artStyle);
  // Joined rather than concatenated: each part is optional (older books have no
  // style, a built-in book has no model), and ' · ' between the ones that exist
  // beats hand-counting which separator is due.
  const meta = [
    book.result.textProvider
      ? builtinStory
        ? m['settings.storybooks.written_builtin']()
        : m['settings.storybooks.written_by']({
            model: book.result.textModel || book.result.textProvider,
          })
      : null,
    style,
    art,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/settings/storybooks"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            'gap-2'
          )}
        >
          <ArrowLeft className="size-4" />
          {m['settings.storybooks.back_to_library']()}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          {/* Which model wrote the story, so a misconfigured one is visible
              rather than passing for a working setup — and which styles, so the
              book can be identified without re-reading it. */}
          {meta.length > 0 && (
            <p className="text-muted-foreground text-xs">{meta.join(' · ')}</p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={download.isPending}
            onClick={() => download.mutate()}
          >
            {download.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {download.isPending
              ? m['settings.storybooks.pdf_preparing']()
              : m['settings.storybooks.download_pdf']()}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive gap-2"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="size-4" />
            {m['settings.storybooks.delete']()}
          </Button>
        </div>
      </div>

      {builtinStory && (
        <p className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-2 text-xs">
          {m['settings.storybooks.builtin_hint']()}
        </p>
      )}

      {/* The book is read as the printable PDF it will be printed from, rather
          than as a separate on-screen rendering that could drift from it. */}
      <div className="bg-card ring-foreground/5 overflow-hidden rounded-2xl ring-1">
        <object
          data={`/api/storybooks/${id}/pdf?inline=1#view=FitH`}
          type="application/pdf"
          title={book.result.title}
          className="h-[80vh] w-full"
        >
          <div className="flex flex-col items-center gap-3 p-16 text-center">
            <p className="text-muted-foreground text-sm">
              {m['settings.storybooks.viewer_unavailable']()}
            </p>
            <Button
              className="gap-2"
              disabled={download.isPending}
              onClick={() => download.mutate()}
            >
              {download.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {m['settings.storybooks.download_pdf']()}
            </Button>
          </div>
        </object>
      </div>

      {deleteDialog}
    </div>
  );
}

export const Route = createFileRoute('/settings/storybooks/$id')({
  component: ReaderPage,
});
