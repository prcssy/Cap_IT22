import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <section>
      <h1>Page Not Found</h1>
      <p>The page you are looking for does not exist.</p>
      <Link to="/">Go back home</Link>
    </section>
  );
}
