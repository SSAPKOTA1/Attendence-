import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { isManager, useAuth } from './lib/auth';
import { HotelProvider } from './components/hotel';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import { ForgotPage, LoginPage, SetPasswordPage } from './pages/AuthPages';

const Kiosk = lazy(() => import('./pages/kiosk/Kiosk'));
const Dashboard = lazy(() => import('./pages/portal/Dashboard'));
const Schedule = lazy(() => import('./pages/portal/Schedule'));
const TimeOff = lazy(() => import('./pages/portal/TimeOff'));
const Attendance = lazy(() => import('./pages/portal/Attendance'));
const Wishes = lazy(() => import('./pages/portal/Wishes'));
const Setup = lazy(() => import('./pages/manage/Setup'));
const Inquiries = lazy(() => import('./pages/portal/Inquiries'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
const Roster = lazy(() => import('./pages/manage/Roster'));
const Live = lazy(() => import('./pages/manage/Live'));
const Requests = lazy(() => import('./pages/manage/Requests'));
const Staff = lazy(() => import('./pages/manage/Staff'));
const StaffDetail = lazy(() => import('./pages/manage/StaffDetail'));
const ManageAttendance = lazy(() => import('./pages/manage/Attendance'));
const Analytics = lazy(() => import('./pages/manage/Analytics'));
const Devices = lazy(() => import('./pages/manage/Devices'));

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}
function RequireManager({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return isManager(user) ? <>{children}</> : <Navigate to="/" replace />;
}
function RequireEmployee({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.employeeId ? <>{children}</> : <Navigate to="/" replace />;
}
function Home() {
  const { user } = useAuth();
  if (isManager(user)) return <Navigate to="/manage/roster" replace />;
  return <Navigate to={user?.employeeId ? '/portal' : '/profile'} replace />;
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPage />} />
        <Route path="/reset-password" element={<SetPasswordPage mode="reset" />} />
        <Route path="/accept-invite" element={<SetPasswordPage mode="invite" />} />
        <Route path="/kiosk" element={<Kiosk />} />
        <Route element={<RequireAuth><HotelProvider><Layout /></HotelProvider></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="portal" element={<RequireEmployee><Dashboard /></RequireEmployee>} />
          <Route path="portal/schedule" element={<RequireEmployee><Schedule /></RequireEmployee>} />
          <Route path="portal/time-off" element={<RequireEmployee><TimeOff /></RequireEmployee>} />
          <Route path="portal/attendance" element={<RequireEmployee><Attendance /></RequireEmployee>} />
          <Route path="portal/wishes" element={<RequireEmployee><Wishes /></RequireEmployee>} />
          <Route path="portal/inquiries" element={<Inquiries />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="profile" element={<Profile />} />
          <Route path="manage/roster" element={<RequireManager><Roster /></RequireManager>} />
          <Route path="manage/live" element={<RequireManager><Live /></RequireManager>} />
          <Route path="manage/requests" element={<RequireManager><Requests /></RequireManager>} />
          <Route path="manage/staff" element={<RequireManager><Staff /></RequireManager>} />
          <Route path="manage/staff/:id" element={<RequireManager><StaffDetail /></RequireManager>} />
          <Route path="manage/attendance" element={<RequireManager><ManageAttendance /></RequireManager>} />
          <Route path="manage/analytics" element={<RequireManager><Analytics /></RequireManager>} />
          <Route path="manage/devices" element={<RequireManager><Devices /></RequireManager>} />
          <Route path="manage/setup" element={<RequireManager><Setup /></RequireManager>} />
          <Route path="manage/inquiries" element={<RequireManager><Inquiries /></RequireManager>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
