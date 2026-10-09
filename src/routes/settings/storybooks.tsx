import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  BookOpenText,
  Coins,
  Download,
  ImagePlus,
  Loader2,
  Palette,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { Link } from '@/core/i18n/navigation';
import {
  ART_STYLES,
  DEFAULT_ART_STYLE_ID,
  DEFAULT_STORYBOOK_STYLE,
  isWordlessStyle,
  STORYBOOK_DEFAULT_PAGES,
  STORYBOOK_MAX_PAGES,
  STORYBOOK_MIN_PAGES,
  STORYBOOK_STYLES,
  storybookCostCredits,
  type ArtStyle,
  type StorybookStyle,
} from '@/modules/storybook/styles';
import { apiDelete, apiDownload, apiGet, apiPost } from '@/lib/api-client';
import { saveBlobAsFile } from '@/lib/download';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import {
  ImageUploader,
  type ImageUploaderValue,
} from '@/components/image-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import {
  ART_STYLE_DESCRIPTIONS,
  ART_STYLE_LABELS,
  artStyleLabel,
  STORY_STYLE_DESCRIPTIONS,
  STORY_STYLE_LABELS,
  storybookStyleLabel,
} from './-storybook-styles';

type StorybookListItem = {
  id: string;
  status: string;
  prompt: string;
  costCredits: number;
  createdAt: string;
  title: string | null;
  coverImageUrl: string | null;
  pageCount: number;
  language: string | null;
  /** How the text was written; `builtin` means no LLM is configured. */
  textProvider: string | null;
  textModel: string | null;
  /** Which narrative style the story was written in. */
  storyStyle: string | null;
  /** Which illustration style the pages were drawn in; null on older books. */
  artStyle: string | null;
  /** Illustrations finished / total, while the book is still generating. */
  progressDone: number;
  progressTotal: number;
  error: string | null;
};

type StoryPage = { text: string; scene: string };
type StoryDraft = {
  title: string;
  pages: StoryPage[];
  storyStyle?: string;
};

const AGE_GROUPS = ['2-4', '5-7', '8-10'] as const;
const LANGUAGES = ['en', 'zh'] as const;
const MAX_PHOTOS = 6;

/** Every page count the service accepts, for the picker. */
const PAGE_COUNTS = Array.from(
  { length: STORYBOOK_MAX_PAGES - STORYBOOK_MIN_PAGES + 1 },
  (_, i) => STORYBOOK_MIN_PAGES + i
);

const schema = z.object({
  idea: z.string().trim().min(3).max(500),
  childName: z.string().trim().max(50),
  ageGroup: z.enum(AGE_GROUPS),
  language: z.enum(LANGUAGES),
  style: z.enum(STORYBOOK_STYLES),
  artStyle: z.enum(ART_STYLES),
  pageCount: z.number().int().min(STORYBOOK_MIN_PAGES).max(STORYBOOK_MAX_PAGES),
});

function StatusBadge({ status }: { status: string }) {
  if (status === 'success')
    return <Badge>{m['settings.storybooks.status_success']()}</Badge>;
  if (status === 'failed')
    return (
      <Badge variant="destructive">
        {m['settings.storybooks.status_failed']()}
      </Badge>
    );
  return (
    <Badge variant="secondary">
      {m['settings.storybooks.status_processing']()}
    </Badge>
  );
}

function StorybooksPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<StoryDraft | null>(null);
  const [photos, setPhotos] = useState<ImageUploaderValue[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  /** The book awaiting delete confirmation, or null when no dialog is open. */
  const [bookToDelete, setBookToDelete] = useState<StorybookListItem | null>(
    null
  );

  // Uploads that finished and therefore have a storage key to submit.
  const characters = photos.flatMap((photo) =>
    photo.status === 'uploaded' && photo.key
      ? [{ key: photo.key, name: names[photo.id]?.trim() || undefined }]
      : []
  );
  const uploading = photos.some((photo) => photo.status === 'uploading');

  const listQuery = useQuery({
    queryKey: ['storybooks'],
    queryFn: () => apiGet<{ items: StorybookListItem[] }>('/api/storybooks'),
    refetchInterval: (q) =>
      q.state.data?.items.some(
        (b) => b.status === 'pending' || b.status === 'processing'
      )
        ? 5000
        : false,
  });
  const books = listQuery.data?.items ?? [];

  const balanceQuery = useQuery({
    queryKey: ['user-credits', 'balance'],
    queryFn: () => apiGet<{ balance: number }>('/api/credits'),
  });
  const balance = balanceQuery.data?.balance ?? null;

  // Building a PDF re-downloads and re-encodes every illustration, so it takes
  // a few seconds — `downloadMutation.variables` is what the spinner keys off.
  const downloadMutation = useMutation({
    mutationFn: (bookId: string) =>
      apiDownload(`/api/storybooks/${bookId}/pdf`),
    onSuccess: ({ blob, filename }, bookId) => {
      saveBlobAsFile(blob, filename || `storybook-${bookId}.pdf`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (bookId: string) => apiDelete(`/api/storybooks/${bookId}`),
    onSuccess: () => {
      toast.success(m['settings.storybooks.deleted']());
      setBookToDelete(null);
      queryClient.invalidateQueries({ queryKey: ['storybooks'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createMutation = useMutation({
    mutationFn: (vars: {
      idea: string;
      story: StoryDraft;
      childName?: string;
      ageGroup: (typeof AGE_GROUPS)[number];
      language: (typeof LANGUAGES)[number];
      style: StorybookStyle;
      artStyle: ArtStyle;
      pageCount: number;
      characters: { key: string; name?: string }[];
    }) => apiPost('/api/storybooks', vars),
    onSuccess: () => {
      toast.success(m['settings.storybooks.toast_created']());
      queryClient.invalidateQueries({ queryKey: ['storybooks'] });
      queryClient.invalidateQueries({ queryKey: ['user-credits'] });
      // Back to a blank form; the new book shows up in the library below, where
      // its progress can be watched.
      setDraft(null);
      setPhotos([]);
      setNames({});
      form.reset();
    },
    onError: (e: Error) => {
      const message = e.message.toLowerCase();
      if (message.includes('insufficient')) {
        toast.error(m['settings.storybooks.toast_no_credits']());
      } else if (message.includes('reference-image model')) {
        toast.error(m['settings.storybooks.toast_no_edit_model']());
      } else if (message.includes('image provider')) {
        toast.error(m['settings.storybooks.toast_no_provider']());
      } else {
        toast.error(e.message);
      }
    },
    onSettled: () => setCreating(false),
  });

  const form = useForm({
    defaultValues: {
      idea: '',
      childName: '',
      ageGroup: '5-7' as (typeof AGE_GROUPS)[number],
      language: 'en' as (typeof LANGUAGES)[number],
      style: DEFAULT_STORYBOOK_STYLE as StorybookStyle,
      artStyle: DEFAULT_ART_STYLE_ID as ArtStyle,
      pageCount: STORYBOOK_DEFAULT_PAGES,
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      // Step 1: write the story. Free, so it can be redone as often as the user
      // likes — the credits are only spent on the illustrations, in step 2.
      setDrafting(true);
      try {
        const story = await apiPost<StoryDraft>('/api/storybooks/draft', {
          idea: value.idea,
          childName: value.childName || undefined,
          characterNames: characters
            .map((c) => c.name)
            .filter((name): name is string => Boolean(name)),
          ageGroup: value.ageGroup,
          language: value.language,
          style: value.style,
          pageCount: value.pageCount,
        });
        setDraft(story);
        toast.success(m['settings.storybooks.toast_drafted']());
      } catch (e: any) {
        toast.error(e?.message || 'Failed to write the story');
      } finally {
        setDrafting(false);
      }
    },
  });

  const busy = creating || drafting;
  // Kept in step with the server's own arithmetic — the confirmation screen
  // quotes a price, and quoting one the API would not charge is worse than
  // showing none.
  const cost = storybookCostCredits(form.state.values.pageCount);
  const wordless = isWordlessStyle(form.state.values.style);
  // How much the chosen length is beyond what the user can pay for. Checked
  // while they are picking the page count, instead of letting them write a
  // whole story and then be refused at the till. `balance` is null until
  // /api/credits answers, and warning off a guess would be worse than warning
  // a moment late.
  const shortfall = balance !== null && balance < cost ? cost - balance : 0;

  const updatePage = (index: number, patch: Partial<StoryPage>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            pages: current.pages.map((page, i) =>
              i === index ? { ...page, ...patch } : page
            ),
          }
        : current
    );
  };

  const confirm = () => {
    if (!draft) return;
    setCreating(true);
    createMutation.mutate({
      idea: form.state.values.idea,
      story: draft,
      childName: form.state.values.childName || undefined,
      ageGroup: form.state.values.ageGroup,
      language: form.state.values.language,
      style: form.state.values.style,
      artStyle: form.state.values.artStyle,
      pageCount: form.state.values.pageCount,
      characters,
    });
  };

  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-bold">
          {m['settings.storybooks.title']()}
        </h1>
        <p className="text-muted-foreground">
          {m['settings.storybooks.description']()}
        </p>
      </div>

      {/* Step 1 — the idea, the photos, and the story */}
      {!draft && (
        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="flex items-center gap-2">
                <Wand2 className="text-primary size-5" />
                {m['settings.storybooks.create_title']()}
              </CardTitle>
              <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <Coins className="size-4" />
                {balance === null ? '…' : balance}{' '}
                {m['settings.storybooks.credits_left']()}
                <span className="text-muted-foreground/60">
                  · {m['settings.storybooks.cost_hint']({ cost: String(cost) })}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                form.handleSubmit();
              }}
            >
              <form.Field name="idea">
                {(field) => (
                  <div className="space-y-2">
                    <Label htmlFor={field.name}>
                      {m['settings.storybooks.field_idea']()}
                    </Label>
                    <Textarea
                      id={field.name}
                      rows={3}
                      maxLength={500}
                      placeholder={m[
                        'settings.storybooks.field_idea_placeholder'
                      ]()}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      disabled={busy}
                    />
                    {field.state.meta.errors.length > 0 && (
                      <p className="text-destructive text-sm">
                        {String(field.state.meta.errors[0]?.message ?? '')}
                      </p>
                    )}
                  </div>
                )}
              </form.Field>

              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                <form.Field name="childName">
                  {(field) => (
                    <div className="space-y-2">
                      <Label htmlFor={field.name}>
                        {m['settings.storybooks.field_name']()}
                      </Label>
                      <Input
                        id={field.name}
                        maxLength={50}
                        placeholder={m[
                          'settings.storybooks.field_name_placeholder'
                        ]()}
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        disabled={busy}
                      />
                    </div>
                  )}
                </form.Field>

                <form.Field name="ageGroup">
                  {(field) => (
                    <div className="space-y-2">
                      <Label>{m['settings.storybooks.field_age']()}</Label>
                      <div className="flex gap-1.5">
                        {AGE_GROUPS.map((age) => (
                          <button
                            key={age}
                            type="button"
                            disabled={busy}
                            onClick={() => field.handleChange(age)}
                            className={cn(
                              'flex-1 rounded-full border px-3 py-2 text-sm transition-colors',
                              field.state.value === age
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border text-muted-foreground hover:border-primary/50'
                            )}
                          >
                            {age}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </form.Field>

                <form.Field name="language">
                  {(field) => (
                    <div className="space-y-2">
                      <Label>{m['settings.storybooks.field_language']()}</Label>
                      <div className="flex gap-1.5">
                        {LANGUAGES.map((lang) => (
                          <button
                            key={lang}
                            type="button"
                            disabled={busy}
                            onClick={() => field.handleChange(lang)}
                            className={cn(
                              'flex-1 rounded-full border px-3 py-2 text-sm transition-colors',
                              field.state.value === lang
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border text-muted-foreground hover:border-primary/50'
                            )}
                          >
                            {lang === 'en' ? 'English' : '中文'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </form.Field>

                <form.Field name="pageCount">
                  {(field) => (
                    <div className="space-y-2">
                      <Label htmlFor={field.name}>
                        {m['settings.storybooks.field_pages']()}
                      </Label>
                      <Select
                        value={String(field.state.value)}
                        onValueChange={(next) =>
                          field.handleChange(Number(next))
                        }
                        disabled={busy}
                      >
                        <SelectTrigger id={field.name} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAGE_COUNTS.map((count) => (
                            <SelectItem key={count} value={String(count)}>
                              {count}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </form.Field>
              </div>

              {shortfall > 0 && (
                <p className="text-destructive flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <AlertCircle className="size-4 shrink-0" />
                  {m['settings.storybooks.credits_short']({
                    pages: String(form.state.values.pageCount),
                    cost: String(cost),
                    balance: String(balance ?? 0),
                    short: String(shortfall),
                  })}
                  <Link
                    href="/pricing"
                    className="font-medium underline underline-offset-2"
                  >
                    {m['settings.storybooks.buy_credits']()}
                  </Link>
                </p>
              )}

              {/* Narrative style. Each preset is its own set of craft rules for
                  the text model — see modules/storybook/style-prompts. */}
              <form.Field name="style">
                {(field) => (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <Label>{m['settings.storybooks.field_style']()}</Label>
                      <span className="text-muted-foreground text-xs">
                        {m['settings.storybooks.field_style_hint']()}
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {STORYBOOK_STYLES.map((style) => (
                        <button
                          key={style}
                          type="button"
                          disabled={busy}
                          onClick={() => field.handleChange(style)}
                          className={cn(
                            'rounded-xl border px-3 py-2.5 text-left transition-colors',
                            field.state.value === style
                              ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                              : 'border-border hover:border-primary/50'
                          )}
                        >
                          <span className="text-sm font-medium">
                            {STORY_STYLE_LABELS[style]()}
                          </span>
                          <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
                            {STORY_STYLE_DESCRIPTIONS[style]()}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </form.Field>

              {/* Illustration style — a separate axis from the narrative one
                  above: the same story can be a woodcut or a collage. Drawn
                  once at creation and never redrawn, which is what the hint
                  warns about. See modules/storybook/art-style-prompts. */}
              <form.Field name="artStyle">
                {(field) => (
                  <div className="space-y-2 border-t pt-5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <Label className="flex items-center gap-2">
                        <Palette className="text-primary size-4" />
                        {m['settings.storybooks.field_art_style']()}
                      </Label>
                      <span className="text-muted-foreground text-xs">
                        {m['settings.storybooks.field_art_style_hint']()}
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {ART_STYLES.map((artStyle) => (
                        <button
                          key={artStyle}
                          type="button"
                          disabled={busy}
                          onClick={() => field.handleChange(artStyle)}
                          className={cn(
                            'rounded-xl border px-3 py-2.5 text-left transition-colors',
                            field.state.value === artStyle
                              ? 'border-primary bg-primary/5 ring-primary/30 ring-1'
                              : 'border-border hover:border-primary/50'
                          )}
                        >
                          <span className="text-sm font-medium">
                            {ART_STYLE_LABELS[artStyle]()}
                          </span>
                          <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
                            {ART_STYLE_DESCRIPTIONS[artStyle]()}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </form.Field>

              {/* Character photos */}
              <div className="space-y-2 border-t pt-5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Label className="flex items-center gap-2">
                    <ImagePlus className="text-primary size-4" />
                    {m['settings.storybooks.characters_title']()}
                  </Label>
                  <span className="text-muted-foreground text-xs">
                    {m['settings.storybooks.characters_limit']()}
                  </span>
                </div>
                <p className="text-muted-foreground text-sm">
                  {m['settings.storybooks.characters_hint']()}
                </p>
                <ImageUploader
                  allowMultiple
                  maxImages={MAX_PHOTOS}
                  onChange={setPhotos}
                />
                {characters.length > 0 && (
                  <div className="space-y-2 pt-1">
                    {photos
                      .filter((photo) => photo.key)
                      .map((photo) => (
                        <div key={photo.id} className="flex items-center gap-3">
                          <img
                            src={photo.preview}
                            alt=""
                            className="size-10 shrink-0 rounded-lg object-cover"
                          />
                          <Input
                            maxLength={30}
                            value={names[photo.id] ?? ''}
                            placeholder={m[
                              'settings.storybooks.character_name_placeholder'
                            ]()}
                            onChange={(e) =>
                              setNames((current) => ({
                                ...current,
                                [photo.id]: e.target.value,
                              }))
                            }
                            disabled={busy}
                            className="max-w-xs"
                          />
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {wordless && (
                <p className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-2 text-xs">
                  {m['settings.storybooks.wordless_hint']()}
                </p>
              )}

              <div className="flex items-center gap-4">
                <Button
                  type="submit"
                  size="lg"
                  disabled={busy || uploading}
                  className="gap-2 rounded-full"
                >
                  {drafting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {m['settings.storybooks.drafting']()}
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-4" />
                      {m['settings.storybooks.draft_button']()}
                    </>
                  )}
                </Button>
                <p className="text-muted-foreground text-sm">
                  {m['settings.storybooks.drafting_hint']()}
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Step 2 — read (and edit) the story before paying for illustrations */}
      {draft && (
        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <CardTitle className="flex items-center gap-2">
                <BookOpenText className="text-primary size-5" />
                {m['settings.storybooks.review_title']()}
              </CardTitle>
              <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <Coins className="size-4" />
                {balance === null ? '…' : balance}{' '}
                {m['settings.storybooks.credits_left']()}
                <span className="text-muted-foreground/60">
                  · {STORY_STYLE_LABELS[form.state.values.style]()}
                  {' · '}
                  {ART_STYLE_LABELS[form.state.values.artStyle]()}
                </span>
              </div>
            </div>
            <p className="text-muted-foreground text-sm">
              {m['settings.storybooks.review_hint']({
                cost: String(cost),
              })}
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {characters.length > 0 && (
              <p className="text-muted-foreground text-sm">
                {m['settings.storybooks.character_count']({
                  count: String(characters.length),
                })}
                {characters.some((c) => c.name) &&
                  ` · ${characters
                    .map((c) => c.name)
                    .filter(Boolean)
                    .join('、')}`}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="story-title">
                {m['settings.storybooks.review_field_title']()}
              </Label>
              <Input
                id="story-title"
                maxLength={120}
                value={draft.title}
                onChange={(e) =>
                  setDraft((current) =>
                    current ? { ...current, title: e.target.value } : current
                  )
                }
                disabled={creating}
              />
            </div>

            <div className="space-y-4">
              {draft.pages.map((page, index) => (
                <div
                  key={index}
                  className="bg-muted/40 space-y-3 rounded-xl border p-4"
                >
                  <p className="text-muted-foreground text-xs font-medium">
                    {m['settings.storybooks.review_page']({
                      n: String(index + 1),
                    })}
                  </p>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor={`page-text-${index}`}
                      className="text-muted-foreground text-xs"
                    >
                      {m['settings.storybooks.review_text_label']()}
                    </Label>
                    <Textarea
                      id={`page-text-${index}`}
                      rows={2}
                      maxLength={2000}
                      value={page.text}
                      onChange={(e) =>
                        updatePage(index, { text: e.target.value })
                      }
                      disabled={creating}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor={`page-scene-${index}`}
                      className="text-muted-foreground text-xs"
                    >
                      {m['settings.storybooks.review_scene_label']()}
                    </Label>
                    <Textarea
                      id={`page-scene-${index}`}
                      rows={1}
                      maxLength={600}
                      value={page.scene}
                      onChange={(e) =>
                        updatePage(index, { scene: e.target.value })
                      }
                      disabled={creating}
                      className="text-muted-foreground text-sm"
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Restated at the till: this is the last screen before credits are
                spent, and the page count is no longer editable here. */}
            {shortfall > 0 && (
              <p className="text-destructive flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <AlertCircle className="size-4 shrink-0" />
                {m['settings.storybooks.credits_short']({
                  pages: String(form.state.values.pageCount),
                  cost: String(cost),
                  balance: String(balance ?? 0),
                  short: String(shortfall),
                })}
                <Link
                  href="/pricing"
                  className="font-medium underline underline-offset-2"
                >
                  {m['settings.storybooks.buy_credits']()}
                </Link>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                disabled={creating || uploading}
                onClick={confirm}
                className="gap-2 rounded-full"
              >
                {creating ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {m['settings.storybooks.review_confirmed']()}
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" />
                    {m['settings.storybooks.review_confirm']()}
                  </>
                )}
              </Button>
              <Button
                type="button"
                size="lg"
                variant="outline"
                disabled={creating}
                onClick={() => setDraft(null)}
                className="gap-2 rounded-full"
              >
                <ArrowLeft className="size-4" />
                {m['settings.storybooks.review_back']()}
              </Button>
              {creating && (
                <p className="text-muted-foreground text-sm">
                  {m['settings.storybooks.generating_hint']()}
                </p>
              )}
            </div>

            {/* Stated at the point of commitment rather than buried in the
                footer: the request is screened before it is drawn, and this is
                the last screen before the credits go. */}
            <p className="text-muted-foreground text-xs">
              {m['settings.storybooks.aup_notice']()}{' '}
              <Link
                href="/acceptable-use-policy"
                className="underline underline-offset-2"
              >
                {m['landing.footer.aup']()}
              </Link>
            </p>
          </CardContent>
        </Card>
      )}

      {/* Library */}
      <div className="space-y-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <BookOpenText className="size-5" />
          {m['settings.storybooks.library_title']()}
        </h2>

        {listQuery.isPending ? (
          <div className="text-muted-foreground py-12 text-center">…</div>
        ) : books.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <BookOpen className="text-muted-foreground/40 size-12" />
              <p className="text-muted-foreground">
                {m['settings.storybooks.empty']()}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {books.map((book) => {
              const openable = book.status === 'success';
              const href = `/settings/storybooks/${book.id}`;
              // The cover opens the printable PDF itself — the browser's own
              // viewer, full toolbar, no app chrome around it — while the title
              // still goes to the reader, which is where the story text and the
              // page-by-page view live. `inline=1` is what keeps this a preview
              // instead of a download; see the route for the header it sets.
              const pdfHref = `/api/storybooks/${book.id}/pdf?inline=1#view=FitH`;
              const openPdfLabel = m['settings.storybooks.card_open_pdf']();
              const title = book.title ?? book.prompt;
              const style = storybookStyleLabel(book.storyStyle);
              const art = artStyleLabel(book.artStyle);
              const downloading =
                downloadMutation.isPending &&
                downloadMutation.variables === book.id;

              const cover = (
                <div className="bg-muted relative aspect-[4/3] overflow-hidden">
                  {book.coverImageUrl ? (
                    <img
                      src={book.coverImageUrl}
                      alt={title}
                      loading="lazy"
                      className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  ) : (
                    <div className="text-muted-foreground/50 flex size-full flex-col items-center justify-center gap-2">
                      {book.status === 'failed' ? (
                        <AlertCircle className="size-6" />
                      ) : (
                        <>
                          <Loader2 className="size-6 animate-spin" />
                          {book.progressTotal > 0 && (
                            <span className="text-xs tabular-nums">
                              {m['settings.storybooks.progress']({
                                done: String(book.progressDone),
                                total: String(book.progressTotal),
                              })}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  <div className="absolute top-2 right-2">
                    <StatusBadge status={book.status} />
                  </div>
                </div>
              );

              return (
                <Card
                  key={book.id}
                  className={cn(
                    'group flex flex-col overflow-hidden transition-all',
                    openable && 'hover:-translate-y-1 hover:shadow-lg'
                  )}
                >
                  {/* Only the cover and the title navigate. The action row sits
                      in the same card, and a button nested inside a link is
                      both invalid markup and impossible to click.
                      The cover is a plain anchor, not the router's Link: it
                      points at an API route, which has no locale-prefixed
                      variant and must not be intercepted by the router. */}
                  {openable ? (
                    <a
                      href={pdfHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                      title={openPdfLabel}
                    >
                      {cover}
                    </a>
                  ) : (
                    cover
                  )}

                  <CardContent className="flex flex-1 flex-col gap-1.5 p-4">
                    {openable ? (
                      <Link
                        href={href}
                        className="line-clamp-1 font-medium hover:underline"
                      >
                        {title}
                      </Link>
                    ) : (
                      <p className="line-clamp-1 font-medium">{title}</p>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {new Date(book.createdAt).toLocaleDateString()}
                      {book.pageCount > 0 &&
                        ` · ${m['settings.storybooks.pages']({ count: String(book.pageCount) })}`}
                      {style && ` · ${style}`}
                      {art && ` · ${art}`}
                    </p>
                    {book.status === 'failed' && book.error && (
                      <p className="text-destructive line-clamp-2 text-xs">
                        {book.error}
                      </p>
                    )}
                    {/* Surfaced on the card, not just in the reader: a story
                        written by the fallback template looks exactly like a
                        real one, so a text model that never got used would
                        otherwise go unnoticed until someone read closely. */}
                    {book.status === 'success' &&
                      book.textProvider === 'builtin' && (
                        <p className="text-muted-foreground line-clamp-2 text-xs">
                          {m['settings.storybooks.written_builtin']()}
                        </p>
                      )}

                    <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
                      {openable && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={downloading}
                          onClick={() => downloadMutation.mutate(book.id)}
                        >
                          {downloading ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                          {m['settings.storybooks.card_download']()}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive gap-1.5"
                        onClick={() => setBookToDelete(book)}
                      >
                        <Trash2 className="size-3.5" />
                        {m['settings.storybooks.delete']()}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Deleting hides the book from the library for good, so it is confirmed
          rather than done on the spot from a card. */}
      <Dialog
        open={!!bookToDelete}
        onOpenChange={(isOpen) => {
          if (!isOpen && !deleteMutation.isPending) setBookToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m['settings.storybooks.delete_title']()}</DialogTitle>
            <DialogDescription>
              {m['settings.storybooks.delete_description']({
                title: bookToDelete?.title ?? bookToDelete?.prompt ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteMutation.isPending}
              onClick={() => setBookToDelete(null)}
            >
              {m['settings.storybooks.cancel']()}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!bookToDelete || deleteMutation.isPending}
              onClick={() => {
                if (bookToDelete) deleteMutation.mutate(bookToDelete.id);
              }}
            >
              {deleteMutation.isPending
                ? m['settings.storybooks.deleting']()
                : m['settings.storybooks.confirm_delete']()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Route = createFileRoute('/settings/storybooks')({
  component: StorybooksPage,
});
