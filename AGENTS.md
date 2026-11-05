# YULAlab — yerel Codex girişi

Önce [ortak bağlam girişini](../../../AGENTS.md), ardından [bu reponun tek yerel ürün/güvenlik kaynağını](CLAUDE.md) oku. CLAUDE.md içindeki yerel bilgiler Codex ve Claude için aynıdır; teknik yöntemi model seçer, dosya işlem yetkisi üretmez.

Bu dosya Codex ve diğer kod ajanları içindir. Kısa tutulur; ayrıntı `CLAUDE.md`'dedir, çelişkide `CLAUDE.md` doğrudur.

## Yığın
- TypeScript (Node >=24.22.0), tek `braavo` komutu (`dist/braavo.js`) · pnpm 10.33.0 · çalışma zamanı bağımlılığı yok
- Kurulum: `pnpm install --frozen-lockfile`
- Test (CI ile aynı): `pnpm test` (= `vitest run`) · Analiz: `pnpm run lint` (= `tsc --noEmit -p tsconfig.json`)
- Derleme: `pnpm build` · CI ayrıca `pnpm audit --audit-level=moderate` ve `node dist/braavo.js --help` koşar

## Kurallar
- **Minimal diff:** yalnız istenen dosyalara dokun; biçimlendirme/yeniden adlandırma turu yapma.
- Yerelleştirme: `src/forge/locale.ts` (`LOCALES`, 14 dil) ve `src/forge/locale-extra.ts`; doğrulama `src/forge/__tests__/locale.test.ts`. Yeni metni tüm dillere ekle, çeviri yoksa İngilizce bırak.
- Testler: `src/forge/__tests__/` ve `src/daemon/__tests__/` (Vitest); yeni davranışa test ekle, mevcut testi silme ya da atlatma.
- İç dizin `src/forge/` KASITLIDIR, taşıma ya da yeniden adlandırma yapma. Yeni bağımlılığı gerekçesiz ekleme (az bağımlılıklı tasarım).
- Bitirmeden: analiz ve test temiz olmalı; çıktının son 5 satırını rapora koy.

## Dokunulmaz
- Sürüm numarası (`package.json`, `CHANGELOG.md`), imzalama ve npm yayın yapılandırması (`prepublishOnly`) — yalnız açık talimatla; `npm publish` kurucu kapısıdır.
- Kullanıcı yapılandırması `~/.braavo` ve sır dosyaları (`.env*`, anahtarlar, `~/.secrets`).
- Burun Farkı ve Iron Bank.
