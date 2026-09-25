import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { FaArrowLeft } from 'react-icons/fa';
import { BrandingContext } from '../../shared/context/BrandingContext';
import './PrivacyPolicyPage.css';

// Data practices described below are drawn directly from the app's actual
// registration form (src/student/RegistrationPage.jsx), auth/profile flow
// (src/shared/context/AuthContext.jsx), and Firestore/Storage layer
// (src/shared/services/firestoreService.js) — keep this in sync if those
// change what they collect/store.
const LAST_UPDATED = 'September 17, 2026';

function Section({ title, children }) {
  return (
    <section className="pp-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function PrivacyPolicyPage() {
  const { schoolName, contact } = useContext(BrandingContext);
  const contactEmail = contact?.email?.text || contact?.email?.href?.replace(/^mailto:/, '') || '';

  return (
    <div className="pp-page">
      <div className="pp-container">
        <Link to="/" className="pp-back-link">
          <FaArrowLeft /> Back to home
        </Link>

        <header className="pp-header">
          <h1>Privacy Policy</h1>
          <p className="pp-updated">Last updated: {LAST_UPDATED}</p>
        </header>

        <p className="pp-intro">
          This Privacy Policy explains what personal information {schoolName || "St. Rita's College"}'s
          Intramurals / Sportsfest / PRISAA event management system ("the System") collects when you
          register for or use it, how that information is used and stored, and who can see it. By
          creating an account or submitting a registration, you agree to the collection and use of
          information as described here.
        </p>

        <Section title="1. Information We Collect">
          <h3>Account information</h3>
          <p>When you sign up, we collect your email address and password (handled by Firebase
            Authentication — we never see or store your password in plain text), and create a profile
            record containing your name, gender, grade level, and section.</p>

          <h3>Event registration information</h3>
          <p>When you register for an event, we collect:</p>
          <ul>
            <li>Full name, date of birth, age, and gender</li>
            <li>Contact number, and your emergency contact's name and phone number</li>
            <li>Home address (province, city/municipality, barangay, and house no./street)</li>
            <li>Grade/year level and section</li>
            <li>Team name, sport, and position</li>
            <li>An optional message or notes you choose to add</li>
            <li>A photo you upload for identification purposes</li>
            <li>A signed waiver/consent form you upload, where required</li>
          </ul>

          <h3>Information collected automatically</h3>
          <p>While you use the System, an internal activity log records account actions such as
            logins, logouts, registrations, and admin/moderator actions (who did what, and when) for
            accountability and troubleshooting purposes. While filling out the registration form, an
            in-progress draft of your answers is also saved locally in your own browser (not on our
            servers) so you don't lose your progress — this draft never leaves your device and is
            cleared once you submit or clear the form.</p>
        </Section>

        <Section title="2. How We Use Your Information">
          <ul>
            <li>To create and manage your account and verify your identity</li>
            <li>To process and confirm your registration for a sport, team, or event</li>
            <li>To contact you or your emergency contact regarding the event you registered for</li>
            <li>To schedule matches, record results, and compute team rankings</li>
            <li>To maintain an audit trail of account and administrative activity</li>
            <li>To generate school-wide, non-identifying counts (e.g. total players registered) shown
              publicly on the landing page — these public numbers never include names or other
              identifying details</li>
          </ul>
        </Section>

        <Section title="3. Who Can See Your Information">
          <p>Your full registration details (address, emergency contact, contact number, photo, waiver,
            etc.) are visible only to you and to school staff accounts explicitly granted an Admin,
            Moderator, or Super Admin role — there is no public listing of registrants. Staff access is
            granted individually by the school through Firebase, not self-assigned. Other students
            cannot view your registration record.</p>
          <p>Match schedules, team rosters, and rankings are visible to any signed-in user, since they
            are the core purpose of the System. The public landing page (visible without an account)
            only shows aggregate, non-identifying figures — such as total matches, sports, teams, and
            player counts — never individual registration data.</p>
        </Section>

        <Section title="4. How We Store and Protect Your Information">
          <p>The System is built on Firebase (a Google service) for authentication, database (Cloud
            Firestore), and file storage. Data is transmitted over encrypted connections. Email
            verification is required before you can log in. Access to staff-only data is enforced by
            Firestore security rules tied to your account's assigned role.</p>
          <p>We do not use third-party analytics, advertising, or tracking SDKs anywhere in the System —
            the only external service involved in handling your data is Firebase itself.</p>
        </Section>

        <Section title="5. Data Retention and Deletion">
          <p>Your account and registration records are kept for as long as they are needed for the
            event/season they relate to. Between seasons, school administrators may run a data-reset
            process that permanently deletes all registration records (names, addresses, contact
            details, emergency contacts, etc.) and match schedules to prepare for a new season; your
            login account itself is not affected by this reset. Uploaded photo/waiver files may in some
            cases persist in file storage after a registration record is deleted — if you'd like a file
            you uploaded removed, contact the school (see Section 8).</p>
        </Section>

        <Section title="6. Minors and Parental Consent">
          <p>Many users of the System are students who may be minors. Where a sport or event requires a
            signed waiver or parental/guardian consent form, that form must be completed and uploaded
            as part of registration. Parents/guardians may contact the school to review, correct, or
            request deletion of their child's information.</p>
        </Section>

        <Section title="7. Your Rights">
          <p>Consistent with the Philippine Data Privacy Act of 2012 (RA 10173), you may request to
            access, correct, or delete your personal information, or ask how it has been used, by
            contacting the school through the details below. We will respond to reasonable requests
            within a reasonable time.</p>
        </Section>

        <Section title="8. Contact Us">
          <p>If you have questions about this Privacy Policy or how your information is handled,
            contact the school{contactEmail ? <> at <a href={`mailto:${contactEmail}`}>{contactEmail}</a></> : ''} using
            the details listed on the landing page's Contact Us section.</p>
        </Section>

        <Section title="9. Changes to This Policy">
          <p>We may update this Privacy Policy from time to time as the System changes. Continued use
            of the System after an update means you accept the revised policy. The "Last updated" date
            above reflects the most recent revision.</p>
        </Section>
      </div>
    </div>
  );
}
