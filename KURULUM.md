# İki Kişilik Kurulum ve Test

Sıfırdan, ikinizin de kullanabileceği bir noktaya kadar. Sırayla yapın —
her adımın sonunda ne görmeniz gerektiği yazıyor.

## Önce şunu bilin

**Kız arkadaşının hiçbir şey kurmasına gerek yok** — Go da, bu uygulama da,
hiçbiri. Ona sadece iki şey lazım:

1. **Tailscale** (tek kurulum)
2. **Chrome veya Edge**

Uygulama senin bilgisayarında çalışır, o sadece bir adres açar. Yani her
güncelleme yaptığında ona yeni bir dosya göndermen de gerekmiyor.

---

## Adım 1 — Onu tailnet'ine ekle

Bu, ikinizin bilgisayarlarının birbirini görmesini sağlayan tek adım.

1. [login.tailscale.com/admin/users](https://login.tailscale.com/admin/users)
   adresine gir
2. **Invite external users** (veya **Invite users**) → davet bağlantısını
   oluştur
3. Bağlantıyı ona gönder
4. O bağlantıya tıklar, bir Tailscale hesabı açar (Google hesabıyla olur),
   [tailscale.com/download](https://tailscale.com/download) adresinden
   Windows istemcisini kurar ve giriş yapar

**Kontrol:** Senin makinende şunu çalıştır:

```bash
tailscale status
```

Onun makinesi listede görünmeli. Görünmüyorsa daveti kabul etmemiş veya
Tailscale'i açmamış demektir.

---

## Adım 2 — Sunucuyu derle

Sadece bir kez, senin makinende:

```bash
cd /d "<projeyi-indirdiğin-klasör>" && go build -o p2pvoicechat.exe ./cmd/p2pvoicechat
```

**Kontrol:** Klasörde `p2pvoicechat.exe` oluşmalı.

---

## Adım 3 — Sunucuyu çalıştır

Dikkat: `-insecure` ve `-dev` **yok**. Onlar tek makinede test içindi; karşı
taraf için TLS şart.

```bash
p2pvoicechat.exe
```

Şuna benzer bir çıktı verir:

```
share this address with the other person:
  https://100.101.102.103:8443
  (this machine: https://localhost:8443)

using a self-signed certificate: both browsers will warn once.
```

**Bu pencereyi kapatma.** Kapatırsan sunucu durur.

### Windows güvenlik duvarı

İlk çalıştırmada Windows bir izin penceresi açabilir. **Özel ağlar** için izin
ver. Pencere çıkmadıysa ve karşı taraf bağlanamıyorsa, yönetici olarak açtığın
bir komut isteminde:

```bash
netsh advfirewall firewall add rule name="P2PVoiceChat" dir=in action=allow protocol=TCP localport=8443
```

---

## Adım 4 — Ona adresi gönder

Çıktıdaki `https://100.x.x.x:8443` adresini gönder. Bu adres sabittir,
değişmez — bir kere gönderip yer imine eklemesi yeter.

---

## Adım 5 — Sertifika uyarısını geçin (ikiniz de, bir kez)

Adresi açtığınızda tarayıcı kırmızı bir uyarı gösterecek:
**"Bağlantınız gizli değil"**.

Bu beklenen bir durum. Uygulama kendi sertifikasını üretiyor ve o sertifikayı
tanıyan bir kurum yok. Trafik yine de şifreli, üstelik zaten Tailscale'in
WireGuard tüneli içinden geçiyor.

Yapılacak: **Gelişmiş** → **Devam et (güvenli değil)**

> Neden mecburi: tarayıcılar mikrofonu ve ekran yakalamayı yalnızca "güvenli
> bağlam"da açıyor. Düz HTTP ile mikrofon hiç açılmaz.

Uyarıdan tamamen kurtulmak istersen: Tailscale panelinde
[HTTPS sertifikalarını aç](https://login.tailscale.com/admin/dns), sonra
`README.md`'deki `-tls-cert` adımlarını uygula. Şart değil, sadece daha temiz.

---

## Adım 6 — Kulaklık

**İkiniz de kulaklık takın.**

Varsayılan ayar yankı engellemeyi kapalı tutuyor, çünkü açıkken tarayıcı sesi
mono'ya indirip tizleri kırpıyor — yani bu projenin tüm amacını siliyor.
Kulaklık yoksa karşı taraf kendi sesini yankı olarak duyar.

Hoparlörle konuşmanız gerekirse: alttaki **"Yankı engelleme"** kutusunu
ikiniz de işaretleyin. Ses kalitesi düşer ama yankı biter.

---

## Adım 7 — Katılın

İkiniz de **Katıl**'a basın. Tarayıcı mikrofon izni isteyecek, **İzin ver**
deyin.

**Kontrol:** Üst solda yeşil nokta ve **"bağlı"** yazmalı. Sağ üstte
gecikme, jitter ve kayıp sayıları akmaya başlamalı.

---

# Test senaryoları

Sırayla geçin. Her birinin ne göstermesi gerektiği yazıyor.

## 1. Ses

Konuşun.

- ✅ Birbirinizi net duyuyorsunuz
- ✅ Sol alttaki çubuk konuşurken hareket ediyor
- ✅ Üst sağdaki gecikme **50 ms altında** (ikiniz de Türkiye'deyseniz)

❌ Çubuk hareket ediyor ama karşı taraf duymuyorsa: alttaki **Mikrofon**
listesinden doğru cihazı seçin.

## 2. Bağlantı yolu — en önemli test

Üst sağdaki yazıya bakın.

- ✅ Sadece sayılar var (`23 ms · jitter 1.2 ms · kayıp 0`)
- ❌ **`⚠ srflx/host` gibi bir uyarı varsa** trafik doğrudan gitmiyor demektir

Uyarı varsa senin makinende:

```bash
tailscale status
```

Onun satırında `direct` yazmalı. `relay` yazıyorsa gecikme 3-4 katına çıkar.

## 3. Ses kalitesi

Birinizde müzik açın (mikrofona doğru).

- ✅ Stereo geliyor, "telefon sesi" gibi boğuk değil
- **Kalite** listesini `64 kbps`'ye düşürüp geri `160`'a alın — farkı duymalısınız

`64 kbps` Discord'un ücretsiz seviyesi. Aradaki farkı duyduğunuz an bu projenin
neden yapıldığı anlaşılır.

## 4. Ekran paylaşımı — tek yön

Sen **Ekranı paylaş**'a bas, bir pencere seç.

- ✅ O senin ekranını görüyor
- ✅ Küçük yazıları okuyabiliyor
- ✅ Üstteki bilgide `gelen 1920x1080` gibi bir şey yazıyor
- Görüntüye **çift tıklayarak** tam ekran yapabiliyor

## 5. Ekran paylaşımı — çift yönlü

Sen paylaşırken **o da** paylaşsın.

- ✅ İkisi de aynı anda çalışıyor
- ✅ Bağlantı kopmuyor, ses kesilmiyor

## 6. Sistem sesi

Bir video aç ve ekranı paylaş. Seçicide **"Sistem sesini paylaş"** kutusunu
işaretle (Chrome bunu sekme veya tüm ekran paylaşımında sunar, tek pencerede
sunmaz).

- ✅ O, videonun sesini duyuyor
- ✅ Aynı anda senin sesini de duyuyor

## 7. Paylaşımı durdurma

**Paylaşımı durdur**'a bas.

- ✅ Onun ekranında görüntü **kayboluyor**, donmuş bir kare kalmıyor
- ✅ Ses kesintisiz devam ediyor

## 8. Sustur ve bas-konuş

- `M` tuşu → mikrofon kapanıyor, düğme "Sesi aç" oluyor
- **Bas-konuş** kutusunu işaretle → `Boşluk` basılıyken konuşuyorsun,
  bıraktığında kapanıyor

## 9. Dayanıklılık — asıl sınav

Bunlar geçmezse uygulama günlük kullanıma hazır değil demektir.

**a) Sunucu yeniden başlatma.** Sunucu penceresinde `Ctrl+C`, sonra tekrar
`p2pvoicechat.exe`.

- ✅ İkinizde de durum "bağlantı koptu, N sn sonra denenecek" oluyor
- ✅ Sunucu açılınca **elle hiçbir şey yapmadan** geri bağlanıyorsunuz

**b) Wi-Fi.** Onun makinesinde Wi-Fi'yi 10 saniye kapatıp aç.

- ✅ Kendiliğinden toparlanıyor

**c) Kapak.** Onun laptopunun kapağını kapat, bir dakika bekle, aç.

- ✅ Kendiliğinden geri geliyor

## 10. Ayar kalıcılığı

Mikrofon, kalite, ses seviyesini ayarla, sekmeyi kapat ve yeniden aç.

- ✅ Ayarlar geldiği gibi duruyor

## 11. Uzun süre

Bir akşam boyunca açık bırakın.

- ✅ Ses bozulmuyor, gecikme artmıyor
- ✅ Kimse bir şeyi yeniden başlatmak zorunda kalmıyor

Sorun çıkarsa kayıt burada:
`%USERPROFILE%\.p2pvoicechat\server.log`

---

## Sık karşılaşılanlar

| Belirti | Sebep |
|---|---|
| Sayfa hiç açılmıyor | Sunucu kapalı, ya da güvenlik duvarı engelliyor (Adım 3) |
| "Güvenli bağlam yok" uyarısı | `http://` ile açılmış. `https://` olmalı |
| Mikrofon açılmıyor | Sertifika uyarısı geçilmemiş, ya da izin reddedilmiş |
| Karşı taraf kendini duyuyor | Kulaklık yok. Yankı engellemeyi açın |
| "Oda dolu" | Üçüncü bir sekme açık kalmış. Fazlasını kapatın |
| Gecikme yüksek, `⚠` var | Bağlantı `direct` değil `relay` (Test 2) |
| Ekran paylaşımı bilgisayarı yoruyor | **Ekran** ayarını `720p30`'a düşürün |
