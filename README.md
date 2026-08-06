# P2PVoiceChat

İki kişilik, kalıcı bir sesli sohbet ve ekran paylaşımı odası. Tailscale ağı
üzerinden doğrudan uçtan uca bağlanır — ses ve görüntü hiçbir sunucudan
geçmez.

Arama yapılmaz: oda hep açıktır, girip çıkılır.

## Neden

Discord'un ücretsiz sürümü sesi 64 kbps mono'ya, ekran paylaşımını 720p30'a
sıkıştırır ve trafiği kendi sunucularından geçirir. İki kişilik bir kullanımda
bunların hiçbirini yapmak gerekmiyor:

| | Discord (ücretsiz) | Bu |
|---|---|---|
| Ses | 64 kbps mono | 48 kHz stereo Opus, 160 kbps varsayılan (510'a kadar) |
| Ekran | 720p30 | 1080p60'a kadar, sistem sesiyle |
| Yol | Sunucu üzerinden | Doğrudan P2P |

> İlk kez iki kişiyle kuruyorsanız [KURULUM.md](KURULUM.md) adım adım
> anlatıyor ve sırayla geçilecek test senaryolarını içeriyor. Aşağısı
> referans.

## Gereksinimler

- Her iki makinede **Tailscale** kurulu ve aynı tailnet'te
- Chrome veya Edge
- Sunucuyu çalıştıracak tarafta **Go 1.26+** (yalnızca derlemek için)
- **Kulaklık** — varsayılan ayar yankı engellemeyi kapatır, çünkü açıkken
  tarayıcı sesi mono'ya indirip tizleri kırpıyor. Hoparlörle konuşacaksanız
  arayüzden "Yankı engelleme" kutusunu işaretleyin.

## Kurulum

```bash
go build -o p2pvoicechat.exe ./cmd/p2pvoicechat
```

Sonra çalıştırın:

```bash
./p2pvoicechat.exe
```

Açılışta paylaşılacak adresi yazdırır:

```
share this address with the other person:
  https://100.101.102.103:8443
```

Karşı taraf bu adresi tarayıcıda açar, ikiniz de **Katıl**'a basarsınız.

### Sertifika uyarısı

Mikrofon ve ekran yakalama tarayıcıda yalnızca **güvenli bağlamda** çalışır,
bu yüzden uygulama HTTPS sunar ve kendi sertifikasını üretir. İlk açılışta her
iki tarayıcı da bir uyarı gösterir — **Gelişmiş → Devam et** demeniz gerekir.
Bir kez yapılır.

Uyarıyı tamamen kaldırmak isterseniz Tailscale yönetim panelinden
([login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns)) HTTPS
sertifikalarını açın ve gerçek sertifikayı verin:

```bash
tailscale cert --cert-file cert.pem --key-file key.pem <makine>.<tailnet>.ts.net
./p2pvoicechat.exe -tls-cert cert.pem -tls-key key.pem
```

## Kullanım

| Kontrol | Ne yapar |
|---|---|
| **Katıl / Ayrıl** | Odaya girer, çıkar |
| **Sustur** (`M`) | Mikrofonu kapatır |
| **Bas-konuş** (`Boşluk`) | Basılı tutuldukça mikrofon açılır |
| **Ekranı paylaş** | Ekran seçicisini açar. Sistem sesi için seçicideki "ses paylaş" kutusunu işaretleyin |
| Uzak görüntüye **çift tık** | Tam ekran |

Üst çubuktaki sayılar gecikmeyi, jitter'ı ve paket kaybını gösterir. Orada
`⚠ srflx/relay` gibi bir uyarı görürseniz trafik tailnet dışına çıkıyor
demektir; `tailscale status` çıktısında bağlantının `direct` olup olmadığına
bakın.

Ayarlar tarayıcıda saklanır, her açılışta yeniden seçmeniz gerekmez.

## Bayraklar

| Bayrak | Varsayılan | Açıklama |
|---|---|---|
| `-addr` | `:8443` | Dinlenecek adres |
| `-tls-cert`, `-tls-key` | — | Gerçek sertifika kullan (Tailscale'den) |
| `-host` | — | Self-signed sertifikaya eklenecek ek isimler |
| `-insecure` | kapalı | Düz HTTP. Yalnızca `localhost` üzerinden işe yarar, tek makinede iki sekmeyle test için |
| `-dev` | kapalı | Arayüzü binary'den değil diskten servis eder |
| `-log` | `~/.p2pvoicechat/server.log` | Log dosyası (`-` ile kapatılır) |
| `-v` | kapalı | Ayrıntılı log |

### Tek başına test

Karşı tarafa ihtiyaç duymadan, mikrofon bile olmadan denemek için:

```bash
./p2pvoicechat.exe -insecure -dev -addr :8080
```

`http://localhost:8080/?fake` adresini **iki sekmede** açın. `?fake` mikrofon
yerine sentetik bir ton, ekran yerine hareketli bir tuval kullanır; geri kalan
her şey (sinyalleşme, WebRTC anlaşması, transceiver'lar, yeniden bağlanma)
gerçek yolun aynısıdır.

## Nasıl çalışır

```
[Tarayıcı A] ←── WebSocket (yalnızca sinyal) ──→ [Go sunucu] ←──→ [Tarayıcı B]
      │                                                                │
      └──────────── WebRTC / SRTP: ses + ekran (doğrudan) ────────────┘
                       Tailscale (WireGuard) tüneli içinde
```

Go sunucusu medyaya hiç dokunmaz — yalnızca iki tarayıcı arasında SDP ve ICE
mesajlarını taşır ve arayüzü servis eder. Ses ve görüntü doğrudan gider.

ICE sunucusu tanımlı **değildir**. Tailscale zaten her iki makineye yönlendirilebilir
bir adres verdiği için host adayları yeterli; STUN eklemek bağlantının tünelin
dışından kurulmasına yol açardı.

Tasarım kararlarının gerekçeleri [ROADMAP.md](ROADMAP.md) içinde.

## Bilinen sınırlar

- Sunucu kimin makinesinde çalışıyorsa o makine açık olmalı
- Odaya aynı anda yalnızca iki kişi girebilir (tasarım gereği)
- Mobil istemci yok
- Kamera yok, metin sohbeti yok, dosya paylaşımı yok
