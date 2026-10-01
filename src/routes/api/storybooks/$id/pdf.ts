import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { buildPdfFilename, buildStorybookPdf } from '@/modules/storybook/pdf';
import {
  getStorybook,
  rememberStorybookPdf,
} from '@/modules/storybook/service';

/**
 * Printable A4 export of a finished book.
 *
 * The PDF is the book's durable artifact — assembled once at the end of
 * generation and kept in storage — so this normally just hands that file back.
 * Books finished before that was true are rebuilt here on demand, and the
 * rebuild is kept so only the first download pays for it.
 *
 * Errors answer with a real HTTP status and a JSON body rather than the
 * codebase's usual `respErr` (HTTP 200 + `code: -1`): the browser may navigate
 * straight to this URL, and a 200 would make it save an error message as a
 * .pdf file.
 */
function fail(status: number, message: string) {
  return new Response(JSON.stringify({ code: -1, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * RFC 5987 `filename*` needs every character outside attr-char percent-encoded.
 * `encodeURIComponent` leaves `'()!*` alone, and of those only `!` is legal
 * there, so the rest are escaped by hand.
 */
function encodeRfc5987(value: string) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

async function GET({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return fail(401, 'Unauthorized');

  let book;
  try {
    book = await getStorybook(params.id, session.user.id);
  } catch (error: any) {
    return fail(500, error.message || 'Failed to load storybook');
  }
  if (!book) return fail(404, 'Not found');

  if (book.status !== 'success' || !book.result) {
    return fail(
      409,
      book.status === 'failed'
        ? 'This storybook failed to generate'
        : 'This storybook is still being generated'
    );
  }

  // `?inline=1` serves the same file for embedding in the reader's viewer
  // instead of saving it. Everything else — bytes, auth, filename — is shared.
  const inline = new URL(request.url).searchParams.get('inline') === '1';
  const disposition = inline ? 'inline' : 'attachment';

  const name = buildPdfFilename(book.result, book.id);
  // Both forms: legacy clients read `filename`, the rest prefer the UTF-8
  // `filename*` (which is what preserves a Chinese title). `inline` still needs
  // a filename, which is what a viewer shows in its title bar.
  const contentDisposition =
    `${disposition}; filename="${name.ascii}.pdf"; ` +
    `filename*=UTF-8''${encodeRfc5987(name.utf8)}.pdf`;

  try {
    // Books finished since the PDF became the artifact of record already have
    // the file in storage — hand it back instead of rebuilding it. Only older
    // books take the slow path, and they keep their illustrations in our own
    // storage, so the rebuild stays available for them indefinitely.
    if (book.result.pdfUrl) {
      const stored = await fetch(book.result.pdfUrl);
      if (!stored.ok) {
        return fail(502, `Stored PDF is unavailable (${stored.status})`);
      }
      const bytes = await stored.arrayBuffer();
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(bytes.byteLength),
          'Content-Disposition': contentDisposition,
          // Immutable for a given book, but behind auth — private keeps it out
          // of shared caches.
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    const bytes = await buildStorybookPdf(book.result);
    // A one-time cost: the rebuild is kept, so the next download is a plain
    // read like any other book's.
    await rememberStorybookPdf(book.id, book.result, bytes);
    return new Response(new Blob([bytes], { type: 'application/pdf' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': contentDisposition,
        // Rebuilt from the current layout on every request, so it must not be
        // cached against a later change in styling.
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: any) {
    return fail(500, error.message || 'Failed to build the PDF');
  }
}

export const Route = createFileRoute('/api/storybooks/$id/pdf')({
  server: {
    handlers: { GET },
  },
});
