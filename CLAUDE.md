# CLAUDE.md — Braavolabs CLI

Tek `braavo` komutu: çok-modelli council (ask/cascade/savings, BYOK) + pipeline kontrolü (runs, steer, connections). Config: `~/.braavo`. Vizyon/durum: `../VENTURE.md` + `../workspace/` defterleri.

## Komutlar
```bash
npm install
npm test           # vitest
npm run lint       # tsc --noEmit
npm run build      # tsc → dist/ (bin: dist/braavo.js)
node dist/braavo.js --help
```

## Bilinmesi gerekenler
- **İç modül dizini hâlâ `src/forge/`** — KASITLI (rebrand 2026-07-18'de kullanıcı-görünür yüzeyler değişti, iç adlandırma korundu). Yeniden adlandırma girişimi = gereksiz churn, yapma.
- Neredeyse bağımlılıksız tasarım — yeni npm bağımlılığı eklemek karar ister.
- npm-publish / native-signing adımları kurucu-kapılıdır.
- Ana dal `main`; push öncesi kurucuya sor.
