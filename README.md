# Macroni

**Live**: https://quansadie.github.io/macroni/

PWA theo dõi calo với carry-over kỷ luật. Chạy offline, cài lên home screen Android như app native. Dữ liệu lưu ở localStorage (không gửi đi đâu).

## Tính năng

- **Tính TDEE** (Mifflin–St Jeor) từ chiều cao / cân nặng / tuổi / giới / mức vận động
- **Gợi ý mức giảm** 0.3 / 0.5 / 0.7 kg/tuần, kèm đánh dấu "bền vững" vs "khắc nghiệt"
- **Carry-over nợ** (chỉ một chiều): ăn thừa → trừ budget ngày mai. Ăn thiếu → KHÔNG được bù.
- **Phạt bỏ tập**: bỏ buổi đã lên kế hoạch → −150 kcal budget ngày mai (per buổi bỏ)
- **Phạt quên log**: ngày quên log auto-fill = TDEE + 200 kcal
- **Khóa log sau 12h**: không sửa/xóa được log cũ để tránh làm đẹp số
- **Phạt tuần**: tổng 7 ngày dương (ăn thừa net so với baseBudget) → tuần sau budget giảm 50 kcal/ngày. Cần tối thiểu 4 ngày có log trong tuần trước mới kích hoạt (tránh phạt oan khi mới cài hoặc nghỉ dài)
- **Sàn BMR**: budget hiển thị không bao giờ xuống dưới BMR. Nợ vẫn cộng dồn bình thường bên trong, chỉ hiển thị cảnh báo khi floor kích hoạt
- **Reset nợ thủ công**: escape route khi nợ tích lũy bất khả thi (vd. nghỉ 2 tuần). Xác nhận 2 bước (confirm + gõ "RESET"). Mỗi lần reset được ghi lại vĩnh viễn trong Settings
- **Log calo bài tập theo MET**: `kcal = MET × cân × giờ × hệ số cường độ (thấp 0.85 / vừa 1.0 / cao 1.2)`
- **Món ăn quen & bài tập quen**: chọn nhanh từ danh sách, hoặc lưu trực tiếp khi log

## Chạy local

Mở `index.html` bằng một static server bất kỳ — không cần build:

```bash
# Một trong các cách sau:
npx serve .
python -m http.server 8000
```

Service Worker chỉ hoạt động qua `http(s)://` hoặc `localhost`, không dùng `file://`.

## Deploy (free)

Cách nhanh nhất — kéo thả folder này:

- **Netlify Drop**: https://app.netlify.com/drop
- **Vercel**: `npx vercel` trong folder
- **GitHub Pages**: push lên repo, bật Pages cho branch

## Cài lên Android (để dùng như app)

1. Mở URL đã deploy bằng Chrome trên Android
2. Chrome sẽ hiện banner "Thêm vào Màn hình chính" (hoặc menu `⋮` → "Install app")
3. App xuất hiện trên home screen — mở full-screen, chạy offline, icon riêng

## Widget thực sự trên home screen

PWA pinned trên Android không phải true widget (vẫn phải tap để mở). Nếu muốn số kcal còn lại hiện trực tiếp trên home screen:

- Dùng **KWGT** (Android widget engine) đọc JSON từ một endpoint
- Có thể expose dữ liệu từ app này qua một Cloudflare Worker + fetch từ KWGT
- Phức tạp hơn, chưa tích hợp sẵn trong bản này

## Công thức

- **BMR (Mifflin–St Jeor)**:
  - Nam: `10×kg + 6.25×cm − 5×tuổi + 5`
  - Nữ: `10×kg + 6.25×cm − 5×tuổi − 161`
- **TDEE**: `BMR × hệ số vận động` (1.2 / 1.375 / 1.55 / 1.725 / 1.9)
- **Budget cơ bản**: `TDEE − daily_deficit`
- **Budget thực tế hôm nay**: `baseBudget − nợ_cộng_dồn − phạt_bỏ_tập − phạt_tuần`
- **Cập nhật nợ cuối ngày**: `D_next = max(0, D + (net − baseBudget))`

## Cấu trúc file

```
index.html     # UI
app.js         # toàn bộ logic (vanilla JS, ~600 dòng)
styles.css     # mobile-first dark theme
manifest.json  # PWA manifest
sw.js          # service worker (cache-first offline)
icon.svg       # app icon
```

## Tuỳ chỉnh rule

Sửa các hằng số ở đầu `app.js`:

```js
const LOCK_HOURS = 12;
const SKIP_PENALTY = 150;
const MISSED_DAY_SURPLUS = 200;
const WEEKLY_OVERAGE_PENALTY = 50;
```
