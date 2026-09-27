using FluentAssertions;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Nocturne.Core.Models;
using Xunit;

namespace Nocturne.API.Tests.Timestamps;

/// <summary>
/// A <c>DateTime</c>/<c>DateTimeOffset</c> <c>Parse</c> or <c>TryParse</c> call that passes no
/// <see cref="System.Globalization.DateTimeStyles"/> reads a zone-less string as the API host's local
/// time, so the stored instant moves with the container's time zone. Timestamps go through
/// <see cref="UploaderTimestamp"/> instead.
/// </summary>
/// <remarks>
/// A source scan: the CI runner is on UTC, where host-local and UTC agree, so no behavioural test
/// can catch a new call site there.
/// </remarks>
[Trait("Category", "Unit")]
public class HostLocalTimestampParseGuardTests
{
    private static readonly string[] ScannedTrees = ["src/API", "src/Core"];

    private static readonly AllowedSite[] Allowed =
    [
        new("src/API/Nocturne.API/Controllers/V1/EntriesController.cs", "IfModifiedSince",
            "an HTTP-date always names GMT, so the host zone never applies"),
        new("src/API/Nocturne.API/Controllers/V1/ProfileController.cs", "IfModifiedSince",
            "an HTTP-date always names GMT, so the host zone never applies"),
    ];

    private static readonly IReadOnlyList<ParseSite> Sites = Scan();

    [Fact]
    public void NoTimestampIsParsedWithoutDateTimeStyles()
    {
        var offenders = Sites
            .Where(site => !Allowed.Any(allowed => allowed.Covers(site)))
            .Select(site => site.ToString())
            .ToList();

        offenders.Should().BeEmpty(
            "a parse without DateTimeStyles reads a zone-less timestamp in the host's time zone; " +
            "use UploaderTimestamp.TryParse or ParseUtcDateTime, or allowlist the site with a reason");
    }

    [Fact]
    public void EveryAllowlistEntryStillMatchesASite()
    {
        Allowed.Where(allowed => !Sites.Any(allowed.Covers))
            .Should().BeEmpty("a stale entry would silently cover a future call in that file");
    }

    private static List<ParseSite> Scan()
    {
        var root = RepositoryRoot();
        var sites = new List<ParseSite>();

        foreach (var tree in ScannedTrees)
        {
            foreach (var path in Directory.EnumerateFiles(Path.Combine(root, tree), "*.cs",
                         SearchOption.AllDirectories))
            {
                if (path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                    || path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
                {
                    continue;
                }

                var relative = Path.GetRelativePath(root, path).Replace('\\', '/');
                var syntax = CSharpSyntaxTree.ParseText(File.ReadAllText(path));

                sites.AddRange(syntax.GetRoot()
                    .DescendantNodes()
                    .OfType<InvocationExpressionSyntax>()
                    .Where(IsStylelessParse)
                    .Select(call => new ParseSite(
                        relative,
                        syntax.GetLineSpan(call.Span).StartLinePosition.Line + 1,
                        call.ArgumentList.Arguments[0].ToString())));
            }
        }

        return sites;
    }

    /// <summary>
    /// <c>Parse(s)</c>, <c>Parse(s, provider)</c>, <c>TryParse(s, out r)</c> and
    /// <c>TryParse(s, provider, out r)</c> are the overloads with no styles parameter.
    /// </summary>
    private static bool IsStylelessParse(InvocationExpressionSyntax call)
    {
        if (call.Expression is not MemberAccessExpressionSyntax access)
            return false;

        var receiver = access.Expression switch
        {
            MemberAccessExpressionSyntax qualified => qualified.Name.Identifier.Text,
            IdentifierNameSyntax name => name.Identifier.Text,
            _ => null,
        };
        if (receiver is not ("DateTime" or "DateTimeOffset"))
            return false;

        var arguments = call.ArgumentList.Arguments.Count;
        return access.Name.Identifier.Text switch
        {
            "Parse" => arguments is 1 or 2,
            "TryParse" => arguments is 2 or 3,
            _ => false,
        };
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "tests", "Unit")))
                return directory.FullName;

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException($"No tests/Unit directory above {AppContext.BaseDirectory}.");
    }

    private sealed record ParseSite(string Path, int Line, string FirstArgument)
    {
        public override string ToString() => $"{Path}:{Line} ({FirstArgument})";
    }

    private sealed record AllowedSite(string Path, string ArgumentContains, string Reason)
    {
        public bool Covers(ParseSite site) =>
            site.Path == Path && site.FirstArgument.Contains(ArgumentContains, StringComparison.Ordinal);
    }
}
