using System.Globalization;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Moq;
using Nocturne.API.Helpers;
using Nocturne.Core.Models.V4;

namespace Nocturne.API.Tests.Migration;

/// <summary>
/// Uploaders write several treatments at one millisecond, so a migration page can end partway
/// through one. The pull has to return the rest on the next page without repeating what it
/// already returned.
/// </summary>
public class MigrationPagerBoundaryTests
{
    private const int PageSize = LegacyReadLimits.MaxMergedCount;

    private static readonly DateTime Crowded = new(2020, 3, 1, 11, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task More_treatments_at_one_millisecond_than_a_page_holds_are_all_migrated_once()
    {
        var source = new Source();
        source.Add(PageSize + 5, Crowded);
        source.Add(5, Crowded.AddMinutes(-30), step: TimeSpan.FromMinutes(-1));
        var migrated = new List<string>();

        await using var provider = MigrationJobHarness.BuildProvider(source, treatmentOutcome: page =>
        {
            migrated.AddRange(page.Select(t => t.Id!));
            return new DecompositionResult();
        });
        var status = await MigrationJobHarness.RunAsync(provider, onCreated: null, ["treatments"]);

        status.CollectionProgress["treatments"].FailureReason.Should().BeNull();
        migrated.Should().BeEquivalentTo(source.Ids);
    }

    [Fact]
    public async Task A_millisecond_the_source_will_not_widen_past_is_logged_and_stepped_over()
    {
        var source = new Source { CountCap = PageSize };
        source.Add(PageSize + 5, Crowded);
        source.Add(5, Crowded.AddMinutes(-30), step: TimeSpan.FromMinutes(-1));
        var older = source.Ids.TakeLast(5).ToList();
        var migrated = new List<string>();
        var logger = new Mock<ILogger>();

        await using var provider = MigrationJobHarness.BuildProvider(source, treatmentOutcome: page =>
        {
            migrated.AddRange(page.Select(t => t.Id!));
            return new DecompositionResult();
        });
        await MigrationJobHarness.RunAsync(provider, onCreated: null, ["treatments"], logger.Object);

        migrated.Should().Contain(older, "the pull carries on below the crowded millisecond");
        migrated.Should().OnlyHaveUniqueItems();
        logger.Verify(l => l.Log(
                LogLevel.Warning,
                It.IsAny<EventId>(),
                It.Is<It.IsAnyType>((state, _) =>
                    state.ToString()!.Contains("treatments") && state.ToString()!.Contains($"{Crowded:o}")),
                It.IsAny<Exception?>(),
                It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
            Times.Once());
    }

    /// <summary>
    /// Stands in for a Nightscout treatments collection, filtering and sorting on created_at as an
    /// ordinal string, newest first, ties in insertion order.
    /// </summary>
    private sealed class Source : HttpMessageHandler
    {
        private readonly List<(string Id, string CreatedAt)> _records = [];

        public List<string> Ids => _records.Select(r => r.Id).ToList();

        /// <summary>The most records one reply holds, whatever count was asked for.</summary>
        public int CountCap { get; init; } = int.MaxValue;

        public void Add(int count, DateTime at, TimeSpan step = default)
        {
            for (var i = 0; i < count; i++)
            {
                var id = (_records.Count + 1).ToString("x24", CultureInfo.InvariantCulture);
                _records.Add((id, (at + step * i).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)));
            }
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = Uri.UnescapeDataString(request.RequestUri!.PathAndQuery);
            if (request.RequestUri.AbsolutePath != "/api/v1/treatments.json")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));

            var count = Math.Min(
                int.Parse(Regex.Match(url, @"count=(\d+)").Groups[1].Value, CultureInfo.InvariantCulture), CountCap);
            var lte = Regex.Match(url, @"\[\$lte\]=([^&]+)") is { Success: true } match ? match.Groups[1].Value : null;

            var page = _records
                .Where(r => lte is null || string.CompareOrdinal(r.CreatedAt, lte) <= 0)
                .OrderByDescending(r => r.CreatedAt, StringComparer.Ordinal)
                .Take(count)
                .Select(r => $$"""{"_id":"{{r.Id}}","eventType":"Temp Basal","created_at":"{{r.CreatedAt}}"}""");

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent($"[{string.Join(',', page)}]", Encoding.UTF8, "application/json"),
            });
        }
    }
}
