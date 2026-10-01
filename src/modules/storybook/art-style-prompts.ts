import type { ArtStyle } from './styles';

/**
 * The illustration looks a book can be drawn in, as style fragments for the
 * image model.
 *
 * **Server-only on purpose**, exactly like `./style-prompts`: the form needs
 * only the ids (`./styles`) and the labels (`routes/settings/-storybook-styles`),
 * so this prose never reaches the client bundle.
 *
 * Each entry says only *how the picture is made* — medium, line, palette,
 * light. It deliberately contains none of the three things the source briefs
 * carried that cannot survive the trip through this pipeline:
 *
 * - **No subject.** The templates came with their own scene ("a boy named James
 *   and his golden dog"). Here the subject arrives per page as the story's
 *   `scene`, so pasting theirs in would print the same boy and dog on all 16
 *   illustrations of every book.
 * - **No `--ar 4:3`.** That is Midjourney syntax; Kie/fal/Replicate take no
 *   ratio argument and return square images, which is also the better fit for
 *   the A4 portrait page.
 * - **No "children's picture book illustration".** That exact phrase is what
 *   pushed these models into chibi/Q-version figures with oversized heads — see
 *   the admin tip on `ai_image_style`. It is replaced here by naming the medium
 *   and, where the medium is representational, by asking for normal
 *   proportions. The three graphic styles (collage, woodcut, flat) are
 *   *meant* to be stylised, so the warning does not apply to them.
 *
 * The author names (Carle, Briggs, Sendak, Lionni) are load-bearing anchors, not
 * decoration: they move the model much further than the adjectives do. If a
 * provider ever starts rejecting them, describe the look instead.
 *
 * `ART_STYLE_CONTRACT` is appended to every prompt by `buildImagePrompt()` — it
 * is house policy rather than a style, so it lives in one place instead of
 * being repeated in all six entries.
 */
export const ART_STYLE_PRESETS: Record<ArtStyle, string> = {
  watercolor:
    'delicate watercolour and gouache painting, translucent layered washes, soft pastel palette, gentle gradients, ' +
    'visible cold-press paper grain, warm and cosy atmosphere, semi-realistic proportions, fine brush detail',

  collage:
    'cut-paper collage, torn and hand-painted paper shapes layered with visible edges and soft drop shadows, ' +
    'screen-printed fabric patterns, bold saturated colour, tactile handmade texture, in the manner of Eric Carle, ' +
    'simple friendly shapes',

  pencil:
    'fine coloured pencil and wax crayon drawing, visible hand-drawn strokes, soft cross-hatching for shadow, ' +
    'waxy paper texture, restrained muted palette, quiet nostalgic mood, in the tradition of Raymond Briggs, ' +
    'careful natural proportions',

  woodcut:
    'woodblock print, bold expressive carved linework, high-contrast palette of black ink and ochre, ' +
    'visible gouge marks and woodgrain, dramatic chiaroscuro lighting, in the tradition of Maurice Sendak’s ' +
    'cross-hatched linework rendered as carved relief, theatrical and mysterious',

  inkwash:
    'traditional Chinese ink wash painting, freehand xieyi brushwork, wet bleeding washes and dry flying-white ' +
    'brush marks, generous unpainted white space, misty atmospheric depth, restrained palette of ink black and ' +
    'sepia with a single accent colour, poetic and serene',

  flat:
    'flat vector illustration, clean geometric shapes, solid unshaded colour blocking, no gradients and no texture, ' +
    'bold limited palette, strong simple composition, in the spirit of Leo Lionni, modern and playful',
};

/**
 * Appended to every illustration prompt regardless of style.
 *
 * "no text" earns its place: image models put lettering on book covers and
 * signposts unprompted, and a page that prints an invented English word under a
 * Chinese sentence looks broken. `scene` already forbids describing characters'
 * looks; this is the visual counterpart.
 */
export const ART_STYLE_CONTRACT =
  'no text, no lettering, no signage, safe for children';
