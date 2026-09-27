namespace Nocturne.API.Helpers;

/// <summary>
/// Addresses a legacy Nightscout from its configured URL, which may be served under a sub-path
/// behind a reverse proxy.
/// </summary>
/// <remarks>
/// A base whose path lacks a trailing slash loses its last segment when a relative path is
/// resolved against it, and a rooted path discards the base path entirely; either drops the
/// sub-path. A query or fragment on the configured URL would otherwise end up inside the path.
/// </remarks>
public static class NightscoutBaseUri
{
    /// <summary>
    /// The scheme, host, port and path of <paramref name="nightscoutUrl"/>, the path ending in
    /// exactly one slash. User info, query and fragment are dropped.
    /// </summary>
    /// <exception cref="UriFormatException"><paramref name="nightscoutUrl"/> is not an absolute URI.</exception>
    public static Uri For(string nightscoutUrl)
    {
        var configured = new Uri(nightscoutUrl, UriKind.Absolute);
        return new UriBuilder(configured.Scheme, configured.Host, configured.Port)
        {
            Path = configured.AbsolutePath.TrimEnd('/') + "/",
        }.Uri;
    }

    /// <summary>
    /// <paramref name="pathAndQuery"/> under the base of <paramref name="nightscoutUrl"/>, whether
    /// or not it starts with a slash.
    /// </summary>
    /// <inheritdoc cref="For" path="/exception"/>
    public static Uri Resolve(string nightscoutUrl, string pathAndQuery) =>
        new(For(nightscoutUrl), pathAndQuery.TrimStart('/'));
}
