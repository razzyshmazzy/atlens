// Accepts a GitHub username, owner/repo shorthand, or full URL
export default function RepoInput({ url, onChange, loading, onSubmit }) {
  const trimmed = url.trim()
  const isUsername = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(trimmed)
  const isRepo = /^(?:https?:\/\/github\.com\/|github\.com\/)?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/.test(trimmed)
  const isValid = isUsername || isRepo

  function handleKey(e) {
    if (e.key === 'Enter' && isValid && !loading) onSubmit()
  }

  return (
    <div className="repo-input">
      <input
        type="text"
        value={url}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder="username or owner/repo"
        disabled={loading}
        aria-label="GitHub username or repository"
        autoFocus
      />
    </div>
  )
}
