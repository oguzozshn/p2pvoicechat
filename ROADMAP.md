# P2PVoiceChat — Yol Haritası

İki kişi arasında, Tailscale ağı üzerinden doğrudan P2P sesli konuşma ve ekran
paylaşımı.

## Durum

| Faz | Durum | Not |
|---|---|---|
| 0 — Zemin | ✅ | Go iskeleti, Tailscale IP tespiti, gömülü arayüz, `-dev` ile diskten servis |
| 1 — Ses | ✅ | WebSocket sinyalleşme + WebRTC. `host`/`host` aday çifti, UDP, 1 ms RTT. 7 test geçiyor |
| 2 — Ses kalitesi | ✅ | Stereo Opus 48 kHz, canlı bitrate değişimi, cihaz seçimi, seviye göstergesi |
| 3 — Ekran paylaşımı | ✅ | Çift yönlü, tek m-line seti, başlat/durdur yeniden anlaşma gerektirmiyor |
| 4 — Dayanıklılık | ✅ | Üstel geri çekilmeli yeniden bağlanma, ICE restart, sunucu ping'i, dosya logu |
| 5 — Kullanılabilirlik | ✅ | Sustur/bas-konuş, ses seviyesi, giriş-çıkış sesi, kalıcı ayarlar, canlı istatistik |

**Gerçek donanımla doğrulanmayı bekleyenler.** Aşağıdakiler kod olarak yazıldı
ama otomatik testte çalıştırılamadı, çünkü test tarayıcısında mikrofon izni ve
ekran seçici yok:

- Seviye göstergesinin hareket etmesi ve cihaz etiketlerinin dolması
- `getDisplayMedia` ile gerçek ekran yakalama ve **sistem sesi** aktarımı
- Çözünürlük/FPS seçiminin gerçek ekranda uygulanması
- Tam ekran (çift tıklama)
- Uyku/uyanma sonrası ICE restart (sunucu yeniden başlatma ile toparlanma
  doğrulandı, kapak kapatma senaryosu doğrulanmadı)

### Yol boyunca alınan kararlar

- **Teklifi tek taraf verir.** İki taraf da aynı anda offer gönderdiğinde
  (glare) nazik taraf geri sarıyor, ancak Chrome bu geri sarmadan sonra ICE
  adaylarını yeniden toplamıyor — bir taraf hiç aday göndermediği için
  bağlantı asılı kalıyor. Odaya ikinci giren taraf teklifi verir; diğeri
  gerektiğinde `needOffer` gönderip ondan ister. Perfect negotiation mantığı
  emniyet kemeri olarak duruyor.
- **ICE adayları kuyruklanır.** Uzak açıklama gelmeden ulaşan adaylar
  `addIceCandidate` hatası verdiği için biriktirilip sonradan uygulanıyor.
- **Ekran transceiver'ları baştan ayrılır.** Video ve ekran sesi için m-line'lar
  bağlantı kurulurken boş olarak oluşturulur; paylaşım başlatmak/durdurmak
  yalnızca `replaceTrack` çağırır, yeniden anlaşma hiç gerekmez. Bunları
  yalnızca teklifi veren taraf oluşturur — iki taraf da oluşturursa 3 yerine 5
  m-line çıkıyor ve ikisi boşa gidiyor.
- **Paylaşım durumu açıkça bildirilir.** `replaceTrack(null)` karşı taraftaki
  track'i susturmuyor; izleyen kişide donmuş bir kare kalıyor. Bu yüzden
  başlama/durma bilgisi ayrı bir `sharing` mesajıyla gönderiliyor,
  `track.muted` değerine güvenilmiyor.
- **Kopan soket medyayı da yıkar.** WebSocket düştüğünde WebRTC bağlantısı
  ayakta tutulmuyor. Sunucu yeniden bağlanan tarafa yeni polite/initiator rolü
  veriyor; eski rollerle kurulmuş bir bağlantı ayakta kalsaydı iki taraf da
  kendini teklif veren sanırdı.
- **TLS zorunlu.** `getUserMedia` ve `getDisplayMedia` yalnızca güvenli
  bağlamda çalışıyor; tailnet üzerinden düz HTTP ile mikrofon hiç açılmıyor.
  Uygulama kendi self-signed sertifikasını üretiyor. Uyarısız kurulum için
  Tailscale yönetim panelinden HTTPS açılıp `-tls-cert` ile gerçek sertifika
  verilebilir.

## Hedef ve kapsam

**Yapılacak:** İki kişilik kalıcı bir "oda". Girip çıkılır, arama yapılmaz.
Yüksek kaliteli stereo ses, çift yönlü 1080p ekran paylaşımı (sistem sesiyle).

**Yapılmayacak (en azından şimdilik):** Grup çağrısı, kamera, metin sohbeti,
dosya transferi, mobil istemci, sunucu/kanal yönetimi, kullanıcı hesapları.

Metin ve dosya işini PipeChat zaten yapıyor. Faz 7'de birleştirme değerlendirilir.

## Kısıtlar ve varsayımlar

| Varsayım | Sonucu |
|---|---|
| İki taraf da Windows | Tarayıcı olarak Chrome/Edge varsayılır, Safari derdi yok |
| İki taraf da Tailscale'de | NAT geçişi yok, STUN/TURN yok, sabit `100.x` adresleri |
| Sunucu senin PC'nde | PC kapalıysa bağlantı yok — kabul edilen bir takas |
| İkiniz de Türkiye'de | Doğrudan bağlantıda gecikme 15-30 ms beklenir |
| Kulaklık kullanılacak | AEC kapatılabilir, stereo/tam bant ses mümkün olur |

## Teknoloji kararları

| Katman | Seçim | Gerekçe |
|---|---|---|
| Dil | **Go** | PipeChat'te zaten kullanıyorsun, tek binary çıkıyor |
| Sinyalleşme | **WebSocket** (`coder/websocket`) | Basit, iki istemci için fazlasıyla yeter |
| Medya | **Tarayıcının WebRTC'si** | AEC, jitter buffer, Opus, DTLS bedava geliyor |
| Arayüz | **Statik HTML/JS**, `go:embed` ile binary'e gömülü | Tek dosya dağıtım, PipeChat'le aynı his |
| Ağ | **Tailscale**, sadece host candidate | STUN/TURN sunucusu yok, maliyet yok |
| Paketleme (opsiyonel) | **Tauri**, Faz 6'da | Önce tarayıcıda çalışsın |

### Önemli sadeleştirme

Go tarafında `pion/webrtc`'ye **ihtiyaç yok**. Sunucu medyaya hiç dokunmuyor —
sadece iki tarayıcı arasında SDP ve ICE mesajlarını taşıyor. Ses ve video
doğrudan tarayıcıdan tarayıcıya gidiyor.

`pion` ancak Faz 6'da, Tauri'de yerel bir eş olmak istersen gerekir. O günü
gelmeden karmaşıklığı üstlenme.

### Mimari

```
[Tarayıcı A] ←── WebSocket (sinyal) ──→ [Go sunucu] ←── WebSocket ──→ [Tarayıcı B]
      │                                (senin PC'n)                          │
      └──────────── WebRTC / SRTP: ses + ekran (doğrudan) ──────────────────┘
                         Tailscale (WireGuard) tüneli içinde
```

---

## Fazlar

Tahminler "akşam" birimiyle, kabaca 2-3 saatlik oturumlar.

### Faz 0 — Zemin · 1 akşam

- [ ] İki makinede de Tailscale kurulu ve aynı tailnet'te
- [ ] `tailscale status` çıktısında bağlantı **`direct`** görünüyor (`relay` değil)
- [ ] İki makine arası ping ölçüldü, not alındı
- [ ] Go projesi iskeleti: `go mod init`, `cmd/p2pvoicechat`, `internal/`
- [ ] Windows Defender güvenlik duvarında dinlenecek port'a izin verildi

**Başarı kriteri:** Karşı makineden `http://100.x.x.x:8080` adresine girince
"merhaba" yazan boş bir sayfa açılıyor.

> **Tuzak:** Bağlantı `relay` görünüyorsa gecikme çok artar ve tüm ölçümlerin
> yanıltıcı olur. Bunu ilk günde çöz, sonra üzerine bina yap.

---

### Faz 1 — Ses · 2 akşam

- [ ] WebSocket sinyalleşme: `offer` / `answer` / `ice-candidate` mesajları
- [ ] İki istemcilik basit oda mantığı (üçüncü bağlantıyı reddet)
- [ ] `getUserMedia({audio: true})` ile mikrofon
- [ ] `RTCPeerConnection` kurulumu, ICE toplama, bağlantı
- [ ] Uzak sesi `<audio>` elemanına bağla

**Başarı kriteri:** İkiniz de sayfayı açtığınızda birbirinizi duyuyorsunuz ve
5 dakika boyunca kopma olmuyor.

> **Tuzak:** `iceServers: []` bırak. STUN eklersen Tailscale dışı adresler de
> aday olur, bağlantı yanlış yoldan kurulur ve neden yavaş olduğunu anlayamazsın.

---

### Faz 2 — Ses kalitesi · 1 akşam

- [ ] `getUserMedia`'da `channelCount: 2`, `sampleRate: 48000`
- [ ] `echoCancellation`, `noiseSuppression`, `autoGainControl` → `false`
      (kulaklık şart; hoparlörle konuşulacaksa açık bırakılacak bir anahtar koy)
- [ ] SDP'de Opus: `stereo=1; sprop-stereo=1; maxaveragebitrate=160000; useinbandfec=1`
- [ ] Mikrofon/hoparlör seçim menüsü (`enumerateDevices`)
- [ ] Giriş seviyesi göstergesi (konuşurken hareket eden bir çubuk)

**Başarı kriteri:** Ses gözle görülür şekilde Discord'dan iyi. Müzik açtığında
stereo geldiğini duyuyorsun.

> **Not:** 510 kbps'e çıkma. 160 zaten şeffaf, fazlası sadece jitter'a
> duyarlılığı artırır.

---

### Faz 3 — Ekran paylaşımı · 2 akşam

- [ ] `getDisplayMedia({video: true, audio: true})` — sistem sesi dahil
- [ ] Çift yönlü: her iki taraf da aynı anda paylaşabilmeli
- [ ] Paylaşımı başlat/durdur, mevcut bağlantıyı koparmadan
      (`addTrack` değil `replaceTrack` kullan, yeniden anlaşma azalır)
- [ ] Çözünürlük/FPS kontrolü: 1080p30 varsayılan, 60 FPS anahtarı
- [ ] Bitrate sınırı: `sender.setParameters()` ile `maxBitrate`
- [ ] Uzak videoyu tam ekran yapabilme

**Başarı kriteri:** Karşı taraf ekranındaki küçük yazıları okuyabiliyor, video
izlettiğinde sesi de duyuyor, CPU kullanımı makul kalıyor.

> **Tuzak:** Ekran paylaşımı açıkken sesin bozulmaya başlarsa sebep neredeyse
> her zaman video bitrate'inin hattı doldurmasıdır. Ses ve video için ayrı
> bitrate sınırları koy, sesi asla kısma.

---

### Faz 4 — Dayanıklılık · 2-3 akşam

**Hobi projelerinin öldüğü yer burası.** Faz 3 sonunda "çalışıyor" dersin ama
gerçek kullanımda üç günde bir bozulur ve sonunda Telegram'a dönersiniz.

- [ ] WebSocket kopunca üstel geri çekilmeli yeniden bağlanma
- [ ] `iceconnectionstate` → `disconnected` / `failed` olduğunda **ICE restart**
- [ ] Sunucu yeniden başlatıldığında istemciler kendiliğinden toparlansın
- [ ] Laptop kapağı kapanıp açıldığında bağlantı geri gelsin
- [ ] Tailscale kısa süre düşüp geri geldiğinde toparlansın
- [ ] Arayüzde net durum göstergesi: `bağlı / bağlanıyor / koptu`
- [ ] Sunucu tarafında dosyaya log — sorun olduğunda bakacak bir yer

**Başarı kriteri:** Bir hafta boyunca hiçbir şeyi elle yeniden başlatmadan
kullanabiliyorsunuz.

---

### Faz 5 — Kullanılabilirlik · 2 akşam

- [ ] Odada kim var göstergesi
- [ ] Karşı taraf girince/çıkınca kısa bir bildirim sesi
- [ ] Mikrofon sustur (kısayol tuşuyla)
- [ ] Karşı tarafın sesi için ayrı ses seviyesi kaydırıcısı
- [ ] Bas-konuş modu (opsiyonel)
- [ ] Ayarların `localStorage`'da saklanması — her açılışta yeniden seçme derdi olmasın
- [ ] Bağlantı istatistikleri (`getStats`): ping, bitrate, paket kaybı

**Başarı kriteri:** Kız arkadaşın sana sormadan kullanabiliyor.

---

### Faz 6 — Tauri paketi · 2-3 akşam · opsiyonel

Ancak Faz 1-5 bir hafta sorunsuz çalıştıysa başla.

- [ ] Arayüzü Tauri'ye taşı (kod büyük ölçüde aynı kalır)
- [ ] Sistem tepsisi ikonu, kapatınca tepsiye insin
- [ ] Windows ile otomatik başlatma
- [ ] **Güncelleyiciyi ilk günden kur** — sonradan eklemek acı verir
- [ ] Go sunucusunu uygulamanın içinde başlat (ayrı pencere olmasın)

**Başarı kriteri:** Kız arkadaşının makinesine tek bir kurulum dosyası
gönderiyorsun, o çift tıklıyor ve çalışıyor.

---

### Faz 7 — İleride değerlendirilecek

- PipeChat ile birleştirme: metin sohbeti ve dosya transferi aynı uygulamaya
- Kamera desteği
- Kayıt alma
- Mobil (Tauri v2) — masaüstü tamamen oturmadan girme

---

## Riskler

| Risk | Etkisi | Ne yapmalı |
|---|---|---|
| Bağlantı `relay`'e düşüyor | Gecikme 3-4 katına çıkar | Faz 0'da çöz, `tailscale status` ile düzenli kontrol et |
| AEC kapalıyken yankı | Karşı taraf kendini duyar | Kulaklık zorunlu; hoparlör için AEC'yi açan bir anahtar bırak |
| Ekran paylaşımı CPU yiyor | Oyun oynarken FPS düşer | Donanım kodlamanın devrede olduğunu doğrula, 30 FPS varsayılan yap |
| Sunucu senin PC'nde | Sen kapatınca konuşamıyorsunuz | Kabul edilen takas; rahatsız ederse Türkiye lokasyonlu ucuz bir VPS |
| Faz 4 atlanır | 2 hafta sonra proje terk edilir | Faz 4'ü isteğe bağlı görme, en kritik faz o |

## Toplam tahmin

**Faz 0-5: kabaca 10-12 akşam.** Haftada 3-4 akşam çalışırsan ~3 hafta.

Faz 3 sonunda (yaklaşık 6. akşam) zaten günlük kullanıma geçebilecek bir şeyin
olur. Faz 4 ve 5, "çalışıyor"u "kullanıyoruz"a çeviren kısım.
