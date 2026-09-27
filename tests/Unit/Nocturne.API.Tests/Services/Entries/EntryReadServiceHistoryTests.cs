using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Nocturne.API.Services.Entries;
using Nocturne.API.Services.Glucose;
using Nocturne.API.Services.Platform;
using Nocturne.Core.Contracts.V4.Repositories;
using Nocturne.Core.Models.V4;
using Xunit;

namespace Nocturne.API.Tests.Services.Entries;

/// <summary>
/// The v3 entries <c>history/{lastModified}</c> read pages on <c>srvModified</c> (the server write
/// stamp), as Nightscout's <c>lib/api3/generic/history</c> does, not on the reading's clinical time:
/// a reading edited or backfilled after the client's cursor must reach it however old it is.
/// </summary>
[Trait("Category", "Unit")]
public class EntryReadServiceHistoryTests
{
    private static readonly DateTime Cursor = new(2026, 3, 10, 12, 0, 0, DateTimeKind.Utc);
    private static readonly long CursorMills = Mills(Cursor);

    private readonly Mock<ISensorGlucoseRepository> _sgRepo = new();
    private readonly Mock<IMeterGlucoseRepository> _mgRepo = new();
    private readonly Mock<ICalibrationRepository> _calRepo = new();
    private readonly Mock<IDemoModeService> _demoMode = new();

    public EntryReadServiceHistoryTests()
    {
        _demoMode.Setup(d => d.IsEnabled).Returns(false);
        _sgRepo.Setup(r => r.GetModifiedSinceAsync(It.IsAny<long>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        _mgRepo.Setup(r => r.GetModifiedSinceAsync(It.IsAny<long>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        _calRepo.Setup(r => r.GetModifiedSinceAsync(It.IsAny<long>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
    }

    [Fact]
    public async Task ReadingsOlderThanTheCursor_ButWrittenAfterIt_AreDelivered_OldestWriteFirst()
    {
        var backfilled = Sg(Cursor.AddDays(-2), written: Cursor.AddMinutes(1), source: "cgm");
        var edited = Mg(Cursor.AddHours(-6), written: Cursor.AddMinutes(2));
        _sgRepo.Setup(r => r.GetModifiedSinceAsync(CursorMills, 1000, It.IsAny<CancellationToken>()))
            .ReturnsAsync([backfilled]);
        _mgRepo.Setup(r => r.GetModifiedSinceAsync(CursorMills, 1000, It.IsAny<CancellationToken>()))
            .ReturnsAsync([edited]);

        var page = await CreateSut(TestDoubles.CanonicalGlucosePassThrough.Create())
            .GetModifiedSinceAsync(CursorMills, 1000);

        page.Records.Select(e => (e.Type, e.Mills)).Should().Equal(
            ("sgv", Mills(backfilled.Timestamp)),
            ("mbg", Mills(edited.Timestamp)));
        page.Records.Select(e => e.SrvModified).Should().Equal(Mills(backfilled.ModifiedAt), Mills(edited.ModifiedAt));
        page.CursorMills.Should().Be(Mills(edited.ModifiedAt));
    }

    [Fact]
    public async Task NothingWrittenAfterTheCursor_ReturnsAnEmptyPageWithoutACursor()
    {
        var page = await CreateSut(TestDoubles.CanonicalGlucosePassThrough.Create())
            .GetModifiedSinceAsync(CursorMills, 1000);

        page.Records.Should().BeEmpty();
        page.CursorMills.Should().BeNull();
    }

    [Fact]
    public async Task LateBackfillFromALosingStream_IsWithheld_ButAdvancesTheCursor()
    {
        // With no registered devices, pseudo-streams rank by key, so "a-cgm" wins every bucket it
        // reported into. Its reading was delivered on an earlier page; only the losing stream's
        // backfill into the same bucket was written after the cursor.
        var at = Cursor.AddHours(-3);
        var winner = Sg(at, written: Cursor.AddHours(-3), source: "a-cgm");
        var loser = Sg(at.AddMinutes(1), written: Cursor.AddMinutes(5), source: "b-cgm");

        _sgRepo.Setup(r => r.GetModifiedSinceAsync(CursorMills, 1000, It.IsAny<CancellationToken>()))
            .ReturnsAsync([loser]);
        _sgRepo.Setup(r => r.GetAsync(
                It.IsAny<DateTime?>(), It.IsAny<DateTime?>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<int>(), It.IsAny<int>(), It.IsAny<bool>(), It.IsAny<bool>(),
                It.IsAny<DateTime?>(), It.IsAny<Guid?>(), It.IsAny<CancellationToken>(), It.IsAny<Guid?>()))
            .ReturnsAsync((DateTime? from, DateTime? to, string? _, string? _, int _, int _, bool _, bool _,
                DateTime? _, Guid? _, CancellationToken _, Guid? _) =>
                new[] { winner, loser }.Where(r => r.Timestamp >= from && r.Timestamp <= to).ToList());

        var devices = new Mock<IPatientDeviceRepository>();
        devices.Setup(d => d.GetAllAsync(It.IsAny<CancellationToken>())).ReturnsAsync([]);
        var canonical = new CanonicalGlucoseService(_sgRepo.Object, devices.Object, _demoMode.Object);

        var page = await CreateSut(canonical).GetModifiedSinceAsync(CursorMills, 1000);

        page.Records.Should().BeEmpty();
        page.CursorMills.Should().Be(Mills(loser.ModifiedAt));
    }

    private EntryReadService CreateSut(Core.Contracts.Glucose.ICanonicalGlucoseService canonical) =>
        new(_sgRepo.Object, _mgRepo.Object, _calRepo.Object, canonical, _demoMode.Object,
            NullLogger<EntryReadService>.Instance);

    private static long Mills(DateTime value) => new DateTimeOffset(value, TimeSpan.Zero).ToUnixTimeMilliseconds();

    private static SensorGlucose Sg(DateTime at, DateTime written, string source) => new()
    {
        Id = Guid.CreateVersion7(),
        Timestamp = at,
        Mgdl = 120,
        Device = "sensor",
        DataSource = source,
        CreatedAt = written,
        ModifiedAt = written,
    };

    private static MeterGlucose Mg(DateTime at, DateTime written) => new()
    {
        Id = Guid.CreateVersion7(),
        Timestamp = at,
        Mgdl = 140,
        Device = "meter",
        CreatedAt = written,
        ModifiedAt = written,
    };
}
