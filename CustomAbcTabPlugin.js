/**
 * CustomAbcTabPlugin — tablature explicite pour abcjs (testé avec abcjs 6.7.2)
 *
 * Principe :
 *  1. Pré-traitement : les lignes `t:` / `%t:` et la directive `%%tab-instrument`
 *     sont lues puis neutralisées dans le texte ABC (remplacées par un commentaire
 *     de même longueur, pour ne pas décaler startChar/endChar d'abcjs).
 *  2. Rendu : abcjs est appelé AVEC sa tablature native. Elle réserve la place,
 *     dessine les lignes de corde, la clé TAB et les barres de mesure.
 *  3. Post-traitement : les numéros calculés par abcjs sont supprimés et remplacés
 *     par ceux de la ligne `t:`, placés au X de la tête de note et au Y de la corde.
 *
 * Syntaxe :
 *   %%tab-instrument ukulele        (ou guitar ; sinon option `instrument`)
 *   C D E F | [CEG] D E F |
 *   t: c0 c2 e0 e1 | g0c0e0 c2 e0 e1 |
 *
 *   - un jeton par note ou accord, dans l'ordre ; les silences n'en prennent pas ;
 *   - un jeton = une ou plusieurs paires corde+frette : `c0`, `A3D2g0b1e0`, `e12`, `Ex` ;
 *   - `-` ou `.` = rien à écrire pour cet événement (note liée, etc.) ;
 *   - les `|` sont facultatifs mais conseillés : ils servent à recaler mesure par mesure.
 *
 * Limites (v1) : un seul morceau (X:) par appel, tablature sur la première voix
 * de la première portée uniquement, notes d'ornement ignorées.
 */

const INSTRUMENTS = {
  guitar: {
    // ordre du grave à l'aigu ; la corde aiguë est dessinée en haut
    strings: ['E', 'A', 'D', 'g', 'b', 'e'],
    aliases: { G: 'g', B: 'b' },
    caseSensitive: true,
    native: { instrument: 'guitar' },
  },
  ukulele: {
    strings: ['g', 'c', 'e', 'a'],
    aliases: {},
    caseSensitive: false,
    // abcjs n'a pas d'instrument « ukulélé » : on prend un 4 cordes (violin)
    // avec un accordage GCEA. Les chiffres natifs sont de toute façon remplacés.
    native: { instrument: 'violin', tuning: ['G,', 'C', 'E', 'A'] },
  },
};

const INSTRUMENT_ALIASES = { guitare: 'guitar', guitar: 'guitar', uke: 'ukulele', ukulele: 'ukulele', 'ukulélé': 'ukulele' };

const TAB_LINE_RE = /^(\s*%?\s*t:)(.*)$/;
const DIRECTIVE_RE = /^\s*%%\s*tab-instrument\s+(\S+)(.*)$/i;
const FIELD_RE = /^\s*[A-Za-z+]:/;
const BAR_TOKEN_RE = /^(\[?:*\|+:*\]?\d*|\[\d+)$/;
const SKIP_TOKENS = new Set(['-', '.']);

const SVG_NS = 'http://www.w3.org/2000/svg';

export class CustomAbcTabPlugin {
  /**
   * @param {object} abcjs  l'objet ABCJS global
   * @param {object} [options]
   * @param {'guitar'|'ukulele'} [options.instrument='guitar'] instrument si la partition n'a pas de %%tab-instrument
   * @param {string} [options.label='']      libellé affiché devant la TAB (abcjs accepte %T pour l'accordage)
   * @param {string} [options.background='#fff'] couleur du cache derrière les chiffres (masque la ligne de corde)
   * @param {number} [options.fontSize]      taille des chiffres (prioritaire sur fontScale)
   * @param {number} [options.fontScale=0.85] facteur appliqué à la taille de police native d'abcjs
   * @param {string} [options.fontFamily]    police des chiffres ; par défaut celle d'abcjs
   * @param {boolean} [options.warn=true]    afficher les avertissements dans la console
   */
  constructor(abcjs, options = {}) {
    if (!abcjs || typeof abcjs.renderAbc !== 'function') {
      throw new Error('CustomAbcTabPlugin : passez l\'objet ABCJS au constructeur.');
    }
    this.abcjs = abcjs;
    this.options = { instrument: 'guitar', label: '', background: '#fff', warn: true, ...options };
  }

  /**
   * Rend la partition avec la tablature explicite.
   * @param {HTMLElement|string} container élément ou id
   * @param {string} abc texte ABC contenant les lignes t:
   * @param {object} [abcjsOptions] options passées à ABCJS.renderAbc (tablature/add_classes sont gérées ici)
   * @returns {{ tunes: object[], warnings: string[], instrument: string }}
   */
  render(container, abc, abcjsOptions = {}) {
    const prepared = this.prepare(abc);
    const params = { ...abcjsOptions, ...this.abcjsParams(prepared) };
    const tunes = this.abcjs.renderAbc(container, prepared.abc, params);
    const warnings = [...prepared.warnings];
    if (tunes && tunes[0]) warnings.push(...this.apply(tunes[0], prepared));
    if (this.options.warn) warnings.forEach((w) => console.warn('[CustomAbcTabPlugin] ' + w));
    return { tunes, warnings, instrument: prepared.instrument };
  }

  /**
   * Étape A : lit les lignes t: et la directive d'instrument, et renvoie un texte ABC nettoyé
   * de même longueur que l'original.
   */
  prepare(abc) {
    const warnings = [];
    const lines = abc.split('\n');
    const tabLines = [];
    let instrument = null;
    let lastMusic = null; // { start, end } de la dernière ligne de musique
    let offset = 0;

    const out = lines.map((line, i) => {
      const start = offset;
      offset += line.length + 1;

      const dir = line.match(DIRECTIVE_RE);
      if (dir) {
        const name = INSTRUMENT_ALIASES[dir[1].toLowerCase()];
        if (name) instrument = name;
        else warnings.push(`Ligne ${i + 1} : instrument inconnu « ${dir[1]} » (guitar ou ukulele).`);
        return blank(line);
      }

      const tab = line.match(TAB_LINE_RE);
      if (tab) {
        if (!lastMusic) {
          warnings.push(`Ligne ${i + 1} : ligne t: sans ligne de notes au-dessus, ignorée.`);
        } else {
          tabLines.push({ lineNumber: i + 1, music: lastMusic, text: tab[2] });
        }
        return blank(line);
      }

      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('%') && !FIELD_RE.test(line)) {
        lastMusic = { start, end: start + line.length };
      } else if (!trimmed) {
        lastMusic = null; // ligne vide = fin du morceau
      }
      return line;
    });

    instrument = instrument || INSTRUMENT_ALIASES[String(this.options.instrument).toLowerCase()] || 'guitar';
    const def = INSTRUMENTS[instrument];
    for (const tl of tabLines) tl.groups = parseTabLine(tl, def, warnings);

    return { abc: out.join('\n'), instrument, tabLines, warnings };
  }

  /** Options abcjs nécessaires (tablature native pour la place et les lignes). */
  abcjsParams(prepared) {
    const def = INSTRUMENTS[prepared.instrument];
    return {
      add_classes: true,
      tablature: [{ ...def.native, label: this.options.label }],
    };
  }

  /**
   * Étape C : remplace les numéros natifs par ceux des lignes t:.
   * @returns {string[]} avertissements
   */
  apply(tune, prepared) {
    const warnings = [];
    const def = INSTRUMENTS[prepared.instrument];
    const events = collectEvents(tune);
    if (!events.notes.length) return warnings;

    const svg = findSvg(events.notes);
    if (!svg) return ['SVG introuvable : le rendu a-t-il eu lieu dans le DOM ?'];

    const font = readNativeFont(svg, this.options);
    svg.querySelectorAll('.abcjs-tab-number, .abcjs-tab-grace').forEach((el) => el.remove());

    const tabGroups = collectTabGroups(tune);

    for (const tl of prepared.tabLines) {
      const assignments = alignLine(tl, events, warnings);
      for (const { note, token } of assignments) {
        if (!token || !token.length) continue;
        const staff = tune.lines[note.line].staffGroup && findTabStaff(tune.lines[note.line].staffGroup);
        if (!staff) {
          warnings.push(`Ligne ${tl.lineNumber} : pas de portée de TAB trouvée pour cette ligne.`);
          continue;
        }
        const x = noteX(note.el);
        const parent = tabGroups.get(note.el.startChar) || ensureLayer(note.el, staff);
        for (const { string, fret } of token) {
          const k = def.strings.length - 1 - def.strings.indexOf(string); // 0 = ligne du haut
          const y = staff.topLine + (k * (staff.bottomLine - staff.topLine)) / (def.strings.length - 1);
          drawFret(parent, x, y, fret, font, this.options.background);
        }
      }
    }
    return warnings;
  }
}

/* ------------------------------------------------------------------ */
/* Pré-traitement                                                      */
/* ------------------------------------------------------------------ */

/** Remplace une ligne par un commentaire de même longueur. */
function blank(line) {
  return line.length ? '%' + ' '.repeat(line.length - 1) : line;
}

/** Découpe une ligne t: en groupes (mesures) de jetons. */
function parseTabLine(tl, def, warnings) {
  const groups = [[]];
  for (const raw of tl.text.trim().split(/\s+/).filter(Boolean)) {
    // une barre peut être collée au jeton : "e1|" ou "|e1"
    const parts = raw.split(/(\[?:*\|+:*\]?\d*)/).filter(Boolean);
    for (const part of parts) {
      if (BAR_TOKEN_RE.test(part)) {
        groups.push([]);
      } else {
        groups[groups.length - 1].push(parseToken(part, def, tl.lineNumber, warnings));
      }
    }
  }
  return groups.filter((g) => g.length);
}

/** "A3D2g0" -> [{string:'A',fret:'3'}, ...] ; "-" -> [] ; invalide -> null */
function parseToken(token, def, lineNumber, warnings) {
  if (SKIP_TOKENS.has(token)) return [];
  const pairs = [];
  const re = /([A-Za-z])(\d+|[xX])/y;
  let m;
  let consumed = 0;
  while ((m = re.exec(token))) {
    consumed = re.lastIndex;
    const string = normaliseString(m[1], def);
    if (!string) {
      warnings.push(`Ligne ${lineNumber} : corde « ${m[1]} » inconnue dans « ${token} » (cordes : ${def.strings.join(' ')}).`);
      return null;
    }
    if (pairs.some((p) => p.string === string)) {
      warnings.push(`Ligne ${lineNumber} : corde « ${string} » utilisée deux fois dans « ${token} ».`);
    }
    pairs.push({ string, fret: m[2].toLowerCase() });
  }
  if (consumed !== token.length || !pairs.length) {
    warnings.push(`Ligne ${lineNumber} : jeton illisible « ${token} ».`);
    return null;
  }
  return pairs;
}

function normaliseString(letter, def) {
  if (def.strings.includes(letter)) return letter;
  if (def.aliases[letter]) return def.aliases[letter];
  if (!def.caseSensitive) {
    const lower = letter.toLowerCase();
    if (def.strings.includes(lower)) return lower;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lecture de la partition rendue                                      */
/* ------------------------------------------------------------------ */

/** Notes et barres de la première voix de la première portée, dans l'ordre du texte. */
function collectEvents(tune) {
  const notes = [];
  const bars = [];
  tune.lines.forEach((line, lineIndex) => {
    const voice = line.staff && line.staff[0] && line.staff[0].voices && line.staff[0].voices[0];
    if (!voice) return;
    for (const el of voice) {
      if (el.el_type === 'note' && !el.rest && el.pitches && el.abselem) {
        notes.push({ el, line: lineIndex, start: el.startChar });
      } else if (el.el_type === 'bar') {
        bars.push(el.startChar);
      }
    }
  });
  return { notes, bars };
}

/** startChar -> groupe SVG de la note de TAB native (pour garder clic et surlignage). */
function collectTabGroups(tune) {
  const map = new Map();
  for (const line of tune.lines) {
    if (!line.staff) continue;
    const tabStaff = line.staff.find((s) => s.clef && s.clef.type === 'TAB');
    const voice = tabStaff && tabStaff.voices && tabStaff.voices[0];
    if (!voice) continue;
    for (const el of voice) {
      const g = el.abselem && el.abselem.elemset && el.abselem.elemset[0];
      if (el.el_type === 'note' && !el.grace && g && !map.has(el.startChar)) map.set(el.startChar, g);
    }
  }
  return map;
}

function findTabStaff(staffGroup) {
  return staffGroup.staffs.find((s) => s.isTabStaff && s.topLine !== undefined);
}

function findSvg(notes) {
  for (const n of notes) {
    const g = n.el.abselem.elemset && n.el.abselem.elemset[0];
    if (g && g.ownerSVGElement) return g.ownerSVGElement;
  }
  return null;
}

/** X du centre de la tête de note (la plus à gauche pour un accord). */
function noteX(el) {
  const pos = el.abselem.notePositions;
  if (pos && pos.length) return Math.min(...pos.map((p) => p.x));
  const h = el.abselem.heads && el.abselem.heads[0];
  return h ? h.x + h.w / 2 : el.abselem.x;
}

/** Associe les jetons d'une ligne t: aux notes de la ligne de musique au-dessus. */
function alignLine(tl, events, warnings) {
  const { start, end } = tl.music;
  const inLine = (c) => c >= start && c < end;
  const notes = events.notes.filter((n) => inLine(n.start));
  const bars = events.bars.filter(inLine);

  // regroupe les notes par mesure
  const noteGroups = [[]];
  let b = 0;
  for (const n of notes) {
    let newMeasure = false;
    while (b < bars.length && bars[b] < n.start) { b++; newMeasure = true; }
    if (newMeasure) noteGroups.push([]);
    noteGroups[noteGroups.length - 1].push(n);
  }
  const musicGroups = noteGroups.filter((g) => g.length);
  const tabGroups = tl.groups;
  const out = [];

  const pair = (ns, ts, where) => {
    if (ns.length !== ts.length) {
      warnings.push(`Ligne ${tl.lineNumber}${where} : ${ts.length} jeton(s) pour ${ns.length} note(s).`);
    }
    for (let i = 0; i < Math.min(ns.length, ts.length); i++) out.push({ note: ns[i], token: ts[i] });
  };

  if (musicGroups.length === tabGroups.length) {
    musicGroups.forEach((ns, i) => pair(ns, tabGroups[i], `, mesure ${i + 1}`));
  } else {
    if (tabGroups.length > 1) {
      warnings.push(`Ligne ${tl.lineNumber} : ${tabGroups.length} mesure(s) en t: pour ${musicGroups.length} dans la musique, alignement note par note.`);
    }
    pair(musicGroups.flat(), tabGroups.flat(), '');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Dessin                                                              */
/* ------------------------------------------------------------------ */

function readNativeFont(svg, options) {
  const sample = svg.querySelector('.abcjs-tab-number');
  let size = 13;
  let family = 'Arial, sans-serif';
  let weight = 'normal';
  if (sample) {
    const cs = getComputedStyle(sample);
    size = parseFloat(sample.getAttribute('font-size')) || parseFloat(cs.fontSize) || size;
    family = sample.getAttribute('font-family') || cs.fontFamily || family;
    weight = sample.getAttribute('font-weight') || cs.fontWeight || weight;
  }
  return {
    size: options.fontSize || size * (options.fontScale ?? 0.85),
    family: options.fontFamily || family,
    weight,
  };
}

/** Calque pour les notes sans groupe de TAB natif (ex. fin de liaison). */
function ensureLayer(noteEl, staff) {
  if (staff._customTabLayer) return staff._customTabLayer;
  const ref = noteEl.abselem.elemset[0];
  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('class', 'abcjs-custom-tab-layer');
  ref.parentNode.appendChild(layer);
  staff._customTabLayer = layer;
  return layer;
}

function drawFret(parent, x, y, fret, font, background) {
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('class', 'abcjs-tab-number abcjs-custom-tab');
  text.setAttribute('x', x);
  text.setAttribute('y', y);
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('font-size', font.size);
  text.setAttribute('font-family', font.family);
  text.setAttribute('font-weight', font.weight);
  text.textContent = fret;
  parent.appendChild(text);

  if (background && background !== 'none') {
    const box = text.getBBox();
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'abcjs-custom-tab-bg');
    rect.setAttribute('x', box.x - 1);
    rect.setAttribute('y', y - box.height * 0.4);
    rect.setAttribute('width', box.width + 2);
    rect.setAttribute('height', box.height * 0.8);
    rect.setAttribute('fill', background);
    rect.setAttribute('stroke', 'none');
    parent.insertBefore(rect, text);
  }
}

export default CustomAbcTabPlugin;
