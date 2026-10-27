import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { CheckoutPage } from './checkout';
import { CartPage } from './pages/CartPage';
import { ReceiptPage } from './pages/ReceiptPage';
import './styles/app.css';

function Cart() {
  const navigate = useNavigate();
  return <CartPage onCheckout={() => navigate('/checkout')} />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/cart" element={<Cart />} />
        <Route path="/checkout" element={<CheckoutPage cartId="demo" totalCents={4200} />} />
        <Route path="/receipt" element={<ReceiptPage totalCents={4200} />} />
      </Routes>
    </BrowserRouter>
  );
}
