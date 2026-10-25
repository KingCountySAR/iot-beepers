import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router';
import { api, type User } from './api';
import { AccessPage } from './pages/Access';
import { ChannelsPage } from './pages/Channels';
import { DashboardPage } from './pages/Dashboard';
import { DevicePage } from './pages/Device';
import { FirmwarePage } from './pages/Firmware';
import { FlashPage } from './pages/Flash';
import { LoginPage } from './pages/Login';
import { PagePage, PagesPage } from './pages/Pages';
import { PairPage } from './pages/Pair';
import { UsersPage } from './pages/Users';

interface AuthState {
  user: User | null;
  setUser: (u: User | null) => void;
}

const AuthContext = createContext<AuthState>({ user: null, setUser: () => {} });
export const useAuth = () => useContext(AuthContext);

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const location = useLocation();

  useEffect(() => {
    api<User | null>('GET', '/auth/me').then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) return null;

  if (!user) {
    return (
      <AuthContext.Provider value={{ user, setUser }}>
        <LoginPage next={location.pathname + location.search} />
      </AuthContext.Provider>
    );
  }

  const logout = async () => {
    await api('POST', '/auth/logout');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      <header className="topbar">
        <strong className="brand">SAR Beepers</strong>
        <nav>
          <NavLink to="/" end>
            {user.isAdmin ? 'Devices' : 'My pagers'}
          </NavLink>
          <NavLink to="/pages">Pages</NavLink>
          <NavLink to="/flash">Flash</NavLink>
          {user.isAdmin && (
            <>
              <NavLink to="/channels">Channels</NavLink>
              <NavLink to="/firmware">Firmware</NavLink>
              <NavLink to="/access">Access</NavLink>
              <NavLink to="/users">Users</NavLink>
            </>
          )}
        </nav>
        <span className="spacer" />
        <span title={user.email}>{user.displayName}</span>
        <button className="link" onClick={logout}>
          Log out
        </button>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/pair" element={<PairPage />} />
          <Route path="/devices/:id" element={<DevicePage />} />
          <Route path="/pages" element={<PagesPage />} />
          <Route path="/pages/:id" element={<PagePage />} />
          <Route path="/flash" element={<FlashPage />} />
          {user.isAdmin && (
            <>
              <Route path="/channels" element={<ChannelsPage />} />
              <Route path="/firmware" element={<FirmwarePage />} />
              <Route path="/access" element={<AccessPage />} />
              <Route path="/users" element={<UsersPage />} />
            </>
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </AuthContext.Provider>
  );
}
