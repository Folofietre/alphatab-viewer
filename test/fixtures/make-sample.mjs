// Regenerates test/fixtures/sample.gp.
//
// The .gp fixture is a binary, so it is generated rather than hand-picked: this
// script is the readable source of truth for what is in it, and re-running it
// after an alphaTab upgrade is how the fixture stays in step with the importer.
//
//   node test/fixtures/make-sample.mjs
//
// It is deliberately NOT wired into `npm test`. The committed .gp is what the
// tests read, so a regression in the exporter cannot hide itself by rewriting
// the fixture on the way in.
//
// What the four tracks are for:
//
//   Lead    6 strings, standard tuning, frets 3-12.
//           The tuning matches an alphaTab preset, and the fret window leaves
//           room to transpose in BOTH directions.
//   Rhythm  7 strings, custom tuning (a low A rather than the low B of the one
//           preset alphaTab knows for 7 strings), frets 0-24.
//           Matches no preset, and its
//           frets are already against both bounds, so it is the track that
//           makes every out-of-range refusal fire.
//   Bass    4 strings, standard tuning, frets 0-7.
//           Different string count from the other two, which is what the
//           "changing the number of strings is not supported" refusal needs.
//   Harm    6 strings, standard tuning, and the only track carrying NATURAL
//           harmonics ({nh}) plus an artificial one ({ah}) for contrast.
//           A natural harmonic sounds at its node rather than at its fret, so
//           this is the track that makes every pitfall-4 refusal fire - and the
//           artificial one is there to prove those refusals do NOT overreach.
//   Drums   percussion, so notes report string -1 / fret -1 and every fret and
//           tuning operation has to skip it.
//
// Plus a tempo MAP of three automations rather than a single tempo, because the
// proportional rewrite is only interesting when there is more than one value.
import * as alphaTab from '@coderline/alphatab'
import fs from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

const tex = `\\title "Edit Fixture"
\\artist "AlphaTab Viewer"
\\album "Test Suite"
\\tempo 120
.
\\track "Lead" \\staff{score tabs} \\tuning e4 b3 g3 d3 a2 e2
\\instrument 30
:4 3.3 5.3 7.3 9.3 |
\\tempo 90
:4 12.2 10.2 8.2 7.2 | 5.4 7.4 9.4 10.4 | 3.1 5.1 7.1 8.1 |
\\track "Rhythm" \\staff{score tabs} \\tuning e4 b3 g3 d3 a2 e2 a1
\\instrument 29
:4 0.1 3.1 5.1 7.1 | 0.7 2.7 3.7 5.7 | 24.2 22.2 20.2 19.2 |
\\tempo 140
:4 12.4 10.4 8.4 7.4 |
\\track "Bass" \\staff{score tabs} \\tuning g2 d2 a1 e1
\\instrument 33
:4 3.1 5.1 3.1 1.1 | 0.2 2.2 3.2 5.2 | 7.3 5.3 3.3 1.3 | 0.4 0.4 0.4 0.4 |
\\track "Harm" \\staff{score tabs} \\tuning e4 b3 g3 d3 a2 e2
\\instrument 27
:4 7.5{nh} 12.4{nh} 5.3 7.3 | 5.2{nh} 12.2{nh} 3.1 5.1 | 9.4 7.4{ah} 5.4 3.4 | 3.3 5.3 7.3 8.3 |
\\track "Drums"
\\instrument percussion
:4 35 38 42 38 | 35 38 42 38 | 35 38 42 38 | 35 38 42 38 |
`

const settings = new alphaTab.Settings()
const importer = new alphaTab.importer.AlphaTexImporter()
importer.initFromString(tex, settings)
const score = importer.readScore()
const bytes = new alphaTab.exporter.Gp7Exporter().export(score, settings)

const out = fileURLToPath(new URL('./sample.gp', import.meta.url))
fs.writeFileSync(out, bytes)
console.log(`wrote ${out} (${bytes.length} bytes)`)
