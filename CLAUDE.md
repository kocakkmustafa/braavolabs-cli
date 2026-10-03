# CLAUDE.md — Braavolabs CLI

Ortak şirket/ürün/servis/durum bağlamı için önce [YULAlab ortak girişini](../../../AGENTS.md) oku. Teknik yöntemi model seçer; bu dosya işlem yetkisi üretmez. Yerel ürün ve güvenlik bilgileri aşağıdadır.

Tek `braavo` komutu: çok-modelli council (ask/cascade/savings, BYOK) + pipeline kontrolü (runs, steer, connections). Config: `~/.braavo`. Vizyon/durum: `../VENTURE.md` + `../workspace/` defterleri.


## Bilinmesi gerekenler
- **İç modül dizini hâlâ `src/forge/`** — KASITLI (rebrand 2026-07-18'de kullanıcı-görünür yüzeyler değişti, iç adlandırma korundu). Bu mevcut iç adlandırmadır; kullanıcı-görünür markayla karıştırılmaz.
- Mevcut CLI az bağımlılıklı tasarıma sahiptir; gerekli teknik değişimin yöntemi modele aittir.
- npm-publish / native-signing adımları kurucu-kapılıdır.
- Ana dal `main`; push öncesi kurucuya sor.
