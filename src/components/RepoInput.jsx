// Controlled input for the GitHub repo URL — submits on Enter
export default function RepoInput({ url, onChange, loading, onSubmit }) {
  const isValidUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(url.trim())

  function handleKey(e) {
    if (e.key === 'Enter' && isValidUrl && !loading) onSubmit()
  }

  return (
    <div className="repo-input">
      <input
        type="url"
        value={url}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder=""
        disabled={loading}
        aria-label="GitHub repository URL"
        autoFocus
      />
    </div>
  )
}
