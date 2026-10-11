# Monetizare — Prăjeală Pro

Ghidul ăsta e pentru autor: ce s-a construit, ce trebuie configurat o singură dată și cum lansezi.

## 1. Modelul

**Freemium cu plată unică.** Efectul de bază rămâne gratuit (asta face aplicația să circule), iar cine se
îndrăgostește de ea plătește o dată pentru tot focul.

| | Gratuit | Pro |
|---|---|---|
| Foc pe cursor (aură / dâră / cometă), explozii la click, scântei | ✓ | ✓ |
| Foc pe fereastra activă, foc la baza ecranului | ✓ | ✓ |
| Palete | Foc clasic, Jar | toate 8 (+ Flacără albastră, Foc verde, Plasmă, **Aurora**, **Aur topit**, **Foc fantomă**) |
| Intensitate | Mică / Medie / Mare | + **Inferno** |
| Monitoare | cel principal | **toate** |
| Funcții Pro viitoare | — | ✓ |

- **Perioadă de probă:** 7 zile de Pro de la prima pornire, fără card. La final, aplicația revine elegant
  la varianta gratuită: setările Pro alese de utilizator nu se pierd, revin automat după cumpărare.
- **Preț recomandat:** 5 € (≈ 25 lei), plată unică, pe până la 3 calculatoare. E un preț „de impuls”
  pentru o jucărie vizuală; poți încerca și „pay what you want, minim 5 €” în Lemon Squeezy.
- Tot ce ține de bani e într-un singur fișier: [`src/shared/product.ts`](../src/shared/product.ts).

## 2. Configurare (o singură dată)

### 2.1 Lemon Squeezy (magazinul)

Lemon Squeezy e *merchant of record*: încasează plata, emite factura, calculează și plătește TVA-ul în UE
și în restul lumii, iar cumpărătorul primește automat cheia de licență pe e-mail. Tu primești banii net.

1. Creează cont pe [lemonsqueezy.com](https://www.lemonsqueezy.com) și un magazin (Store).
2. **Products → New product** „Prăjeală Pro”, *Single payment*, 5 €.
3. În produs, bifează **Generate license keys**:
   - *Activation limit*: **3** (site-ul promite 3 calculatoare — dacă schimbi, schimbă și textul din `site/index.html`);
   - *License length*: **Unlimited**.
4. Notează:
   - **Store ID** — Settings → Stores (numărul de lângă numele magazinului);
   - **Product ID** — în URL-ul produsului sau în lista Products;
   - **Checkout link** — butonul *Share* al produsului.
5. Completează [`src/shared/product.ts`](../src/shared/product.ts):

```ts
buyUrl: 'https://<magazinul-tau>.lemonsqueezy.com/buy/<id>',
lemonSqueezy: Object.freeze({ storeId: 12345, productId: 67890 }),
priceLabel: '5 €',
sponsorUrl: '', // opțional: GitHub Sponsors / Ko-fi
```

6. În [`site/index.html`](../site/index.html), la final, pune același link în `PRAJEALA.buyUrl` (și prețul în `price`).

Cât timp `storeId` e `0`, aplicația refuză cheile de magazin cu un mesaj clar, iar butonul de pe site arată „În curând”.

### 2.2 Chei offline (cadouri, presă, sponsori)

Pe lângă cheile din magazin, poți emite singur chei semnate criptografic (Ed25519) care merg fără internet:

```bash
npm run license -- keygen                         # o singură dată: creează ~/.prajeala/license-private.pem
                                                  # și scrie cheia publică în src/shared/product.ts → comite fișierul
npm run license -- issue --to "Ana Pop <ana@ex.ro>"   # tipărește o cheie PRJ1-…
npm run license -- verify PRJ1-…                  # verifică o cheie
```

- **Fă backup cheii private** (manager de parole). Fără ea nu mai poți emite chei valide pentru aceeași cheie publică.
  Nu o comite niciodată (`*.pem` e în `.gitignore`).
- O cheie scăpată pe internet se revocă adăugând id-ul ei (afișat la `issue`) în `revokedOfflineKeyIds`
  din `product.ts`; la următoarea versiune nu mai funcționează.

### 2.3 Site-ul (GitHub Pages)

1. Repository → **Settings → Pages → Source: GitHub Actions**.
2. La primul push pe `main` care atinge `site/`, workflow-ul *Website* publică pagina la
   <https://fastuber.github.io/prajeala/>.
3. Imaginile din `site/img/` sunt randări reale ale aplicației (vezi *Imagini* mai jos).

### 2.4 Release-uri

```bash
npm version minor          # 0.1.0 → 0.2.0 (commit + tag v0.2.0)
git push --follow-tags
```

CI construiește instalatoarele pentru Windows, macOS și Linux și le pune într-un **release ciornă** pe GitHub.
Îl verifici și apeși *Publish*. Butonul „Descarcă” de pe site duce la ultimul release publicat.

## 3. Testare înainte de lansare

```bash
npm start -- --force-tier=free --settings   # pornește ca o instalare gratuită (fără perioada de probă)
```

- Lemon Squeezy are **Test mode**: cumpără produsul cu un card de test și activează cheia primită în fereastra
  de setări. Cheile de test funcționează cu același API.
- `--force-tier=pro` deblochează tot (doar în build-urile nepachetate, pentru dezvoltare).
- Fișierul licenței: `prajeala-license.json` lângă `prajeala-settings.json` (vezi README). Ștergerea lui
  repornește perioada de probă — util la testare.

## 4. Cum funcționează licențele

- **Activare:** cheia (UUID) se trimite o singură dată la `api.lemonsqueezy.com/v1/licenses/activate`
  (API public, fără chei secrete în aplicație). Numele activării e „Prăjeală · Windows · a1b2c3d4” — fără
  hostname, din motive de confidențialitate.
- **Verificare:** cam o dată pe săptămână, în fundal. Doar un „nu” clar de la magazin (rambursare, cheie
  dezactivată, expirată, ștearsă) scoate Pro. **Lipsa internetului nu scoate niciodată Pro** unui client plătitor.
- **Altă cheie:** cheile altor magazine/produse Lemon Squeezy sunt refuzate (se verifică `store_id` și `product_id`).
- **Mutare pe alt calculator:** „Dezactivează pe acest calculator” în setări sau din pagina comenzii (customer portal).
- **Confidențialitate:** în afară de licență, aplicația nu face nicio conexiune (am dezactivat inclusiv descărcarea
  dicționarelor de spellcheck pe care Electron o face implicit).

## 5. De știut

- **Codul e MIT.** Oricine poate compila din surse o variantă cu Pro deblocat — e legal. Monetizarea se bazează
  pe comoditate (instalatoare gata făcute, actualizări) și pe dorința oamenilor de a susține proiectul, ca la
  majoritatea aplicațiilor open-source plătite. Dacă vrei să împiedici redistribuirea comercială, poți trece
  versiunile viitoare la o licență *source-available* (de ex. PolyForm Noncommercial sau FSL) — decizia îți aparține.
- **Semnarea aplicației contează pentru vânzări.** Fără semnătură, Windows afișează SmartScreen („aplicație
  nerecunoscută”), iar macOS refuză să deschidă DMG-ul până la un click dreapta → Open. Pași recomandați:
  - macOS: Apple Developer Program (99 $/an) + notarizare (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
    în secretele CI, `hardenedRuntime: true` în `electron-builder.yml`);
  - Windows: Azure Trusted Signing sau un certificat OV.
- **Promisiuni de pe site** de verificat/ajustat: rambursare în 14 zile, 3 calculatoare, „funcțiile Pro viitoare”.

## 6. Idei de creștere

- Clipuri scurte (TikTok / Reels / YouTube Shorts) cu ecranul care arde — efectul se vinde vizual.
- Streameri: focul la baza ecranului merge bine ca overlay în OBS (Display Capture).
- Product Hunt, r/unixporn, r/desktops, Hacker News „Show HN”.
- Reducere de lansare (cod Lemon Squeezy), apoi preț normal.
- Funcții Pro viitoare care justifică upgrade-ul: palete personalizate, „focul reacționează la muzică”,
  foc la tastare, teme sezoniere (zăpadă de Crăciun, dovleci de Halloween).

## 7. Imagini

`site/img/hero.jpg` și `site/img/palettes.jpg` sunt randări reale ale overlay-ului, făcute cu pagina de renderer
în modul *mock* într-un Chromium headless (WebGL prin SwiftShader). Parametri utili ai paginii
`dist/renderer/index.html`: `palette=aurora`, `intensity=high`, `bottom=1`, `cursor=comet`, `pin=x,y`
(cursor fix), `window=x,y,w,h` (fereastră activă falsă, fixă). `dist/renderer/settings.html?lang=ro&tier=free`
deschide fereastra de setări cu date simulate.
