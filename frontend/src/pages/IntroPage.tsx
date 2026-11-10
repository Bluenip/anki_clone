import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import './IntroPage.css';

// Start time (seconds) of each step in public/intro/huong-dan.mp4.
export const INTRO_STEPS: { at: number; title: string; text: string }[] = [
  { at: 8, title: 'Đăng nhập', text: 'Bấm Log In, nhập email và mật khẩu. Chưa có tài khoản thì bấm Sign Up.' },
  { at: 22, title: 'Trang Decks', text: 'Xem các bộ thẻ, số thẻ New / Learn / Due. Tạo bộ mới hoặc Import file.' },
  { at: 41, title: 'Mở bộ thẻ', text: 'Bấm tên bộ thẻ để xem tổng quan, rồi bấm Study Now.' },
  { at: 54, title: 'Học thẻ: mặt trước', text: 'Nghe âm thanh, xem hình gợi ý, nghĩ đáp án rồi bấm Show Answer.' },
  { at: 71, title: 'Tự chấm mức độ nhớ', text: 'Again: quên · Hard: nhớ khó · Good: nhớ được · Easy: rất dễ (phím 1–4).' },
  { at: 92, title: 'Thêm thẻ mới', text: 'Mục Add: chọn bộ thẻ, nhập mặt trước và mặt sau, Ctrl + Enter để lưu.' },
  { at: 110, title: 'Tìm và sửa thẻ', text: 'Mục Browse: tìm từ khóa, bấm một thẻ để sửa ở khung bên phải.' },
  { at: 128, title: 'Thống kê', text: 'Mục Stats: số lượt ôn, thời gian học theo 7 ngày, 30 ngày, 90 ngày, 1 năm.' },
  { at: 142, title: 'Học theo ý mình', text: 'Custom Study: ôn theo tag, thẻ đến hạn hoặc học trước.' },
  { at: 156, title: 'Tài khoản', text: 'Mục Account: đổi email hoặc mật khẩu.' },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const IntroPage = () => {
  const { user } = useAuth();
  const video = useRef<HTMLVideoElement>(null);

  const jump = (at: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = at;
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
    v.play().catch(() => {});
  };

  return (
    <div className="intro-page">
      <header className="intro-hero">
        <p className="intro-kicker">Hướng dẫn sử dụng</p>
        <h1>Học bằng thẻ ghi nhớ, mỗi ngày một chút</h1>
        <p className="intro-lead">Xem video 3 phút để biết cách đăng nhập, học thẻ, tự chấm điểm, thêm thẻ mới và theo dõi tiến độ.</p>
        <div className="intro-actions">
          {user ? (
            <Link to="/decks" className="btn btn-primary">Vào bộ thẻ của bạn</Link>
          ) : (
            <>
              <Link to="/register" className="btn btn-primary">Tạo tài khoản miễn phí</Link>
              <Link to="/login" className="btn btn-ghost">Đăng nhập</Link>
            </>
          )}
        </div>
      </header>

      <div className="intro-layout">
        <div className="intro-video glass-card">
          <video ref={video} controls preload="metadata" playsInline poster="/guide-media/poster.jpg">
            <source src="/guide-media/huong-dan.mp4" type="video/mp4" />
            Trình duyệt của bạn không phát được video. <a href="/guide-media/huong-dan.mp4">Tải video về</a>.
          </video>
        </div>

        <ol className="intro-steps" aria-label="Các bước trong video">
          {INTRO_STEPS.map((s, i) => (
            <li key={s.at}>
              <button type="button" onClick={() => jump(s.at)}>
                <span className="intro-step-num">{i + 1}</span>
                <span className="intro-step-body">
                  <span className="intro-step-title">{s.title}<time>{fmt(s.at)}</time></span>
                  <span className="intro-step-text">{s.text}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};

export default IntroPage;
