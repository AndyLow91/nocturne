using Microsoft.AspNetCore.Mvc;
using Nocturne.API.Controllers.V4.Analytics;
using Nocturne.API.Services.Analytics;
using Nocturne.Core.Contracts.V4.Repositories;
using Nocturne.Core.Models.V4;
using BolusType = Nocturne.Core.Models.V4.BolusType;

namespace Nocturne.API.Tests.Controllers.V4.Analytics;

/// <summary>
/// The stats card renders the counts and the summary side by side, so both must come from the
/// one set of records the Treatment Log filter keeps.
/// </summary>
public class TreatmentLogControllerTests
{
    private static readonly DateTime From = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime To = new(2026, 1, 3, 23, 59, 59, DateTimeKind.Utc);

    private readonly Mock<IBolusRepository> _boluses = new();
    private readonly Mock<ICarbIntakeRepository> _carbs = new();
    private readonly Mock<IBGCheckRepository> _bgChecks = new();
    private readonly Mock<INoteRepository> _notes = new();
    private readonly Mock<IDeviceEventRepository> _deviceEvents = new();
    private readonly Mock<IBasalInjectionRepository> _basalInjections = new();
    private readonly TreatmentLogController _controller;

    public TreatmentLogControllerTests()
    {
        _boluses.Setup(r => r.GetAsync(From, To, null, null, TreatmentLogController.RecordLimit, 0, true,
                false, null, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync([
                new Bolus { Insulin = 4, Device = "pump-a", BolusType = BolusType.Normal },
                new Bolus { Insulin = 2, Device = "pen-b" },
            ]);
        _carbs.Setup(r => r.GetAsync(From, To, null, null, TreatmentLogController.RecordLimit, 0, true,
                false, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync([
                new CarbIntake { Carbs = 40, Device = "pump-a" },
                new CarbIntake { Carbs = 25, App = "phone-c" },
            ]);
        _bgChecks.Setup(r => r.GetAsync(From, To, null, null, TreatmentLogController.RecordLimit, 0, true,
                false, It.IsAny<CancellationToken>()))
            .ReturnsAsync([new BGCheck { Device = "pump-a", GlucoseType = GlucoseType.Finger }]);
        _notes.Setup(r => r.GetAsync(From, To, null, null, TreatmentLogController.RecordLimit, 0, true,
                false, It.IsAny<CancellationToken>()))
            .ReturnsAsync([new Note { Text = "Evening walk" }]);
        _deviceEvents.Setup(r => r.GetAsync(From, To, null, null, TreatmentLogController.RecordLimit, 0, true,
                false, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync([new DeviceEvent { EventType = DeviceEventType.SiteChange }]);
        _basalInjections.Setup(r => r.GetAsync(From, To, null, null, TreatmentLogController.RecordLimit, 0, true,
                It.IsAny<CancellationToken>()))
            .ReturnsAsync([new BasalInjection { Notes = "pen" }]);

        _controller = new TreatmentLogController(
            _boluses.Object, _carbs.Object, _bgChecks.Object, _notes.Object,
            _deviceEvents.Object, _basalInjections.Object, new StatisticsService());
    }

    private async Task<TreatmentLogStats> Stats(
        TreatmentLogCategory category, string? search, int dayCount = 3)
    {
        var result = await _controller.GetStats(From, To, dayCount, category, search);
        return (TreatmentLogStats)result.Result.Should().BeOfType<OkObjectResult>().Subject.Value!;
    }

    [Fact]
    public async Task Unfiltered_counts_every_kind_and_summarises_every_bolus_and_carb_intake()
    {
        var stats = await Stats(TreatmentLogCategory.All, null);

        stats.Counts.Should().BeEquivalentTo(new TreatmentLogCounts
        {
            All = 8, Bolus = 2, Carbs = 2, BgCheck = 1, Note = 1, DeviceEvent = 1, BasalInjection = 1,
        });
        stats.TreatmentSummary!.BolusCount.Should().Be(2);
        stats.TreatmentSummary.CarbEntryCount.Should().Be(2);
        stats.TreatmentSummary.Totals.Insulin.Bolus.Should().Be(6);
        stats.TreatmentSummary.Totals.Food.Carbs.Should().Be(65);
        stats.TreatmentSummary.DailyCarbs.Should().BeApproximately(65.0 / 3, 0.01);
    }

    [Fact]
    public async Task Search_keeps_matching_records_and_the_summary_covers_only_those()
    {
        var stats = await Stats(TreatmentLogCategory.All, "  PUMP-A ");

        stats.Counts.Should().BeEquivalentTo(new TreatmentLogCounts { All = 3, Bolus = 1, Carbs = 1, BgCheck = 1 });
        stats.TreatmentSummary!.Totals.Insulin.Bolus.Should().Be(4);
        stats.TreatmentSummary.Totals.Food.Carbs.Should().Be(40);
    }

    [Fact]
    public async Task Category_leaves_other_kinds_out_of_counts_and_summary()
    {
        var stats = await Stats(TreatmentLogCategory.Bolus, "");

        stats.Counts.Should().BeEquivalentTo(new TreatmentLogCounts { All = 2, Bolus = 2 });
        stats.TreatmentSummary!.BolusCount.Should().Be(2);
        stats.TreatmentSummary.CarbEntryCount.Should().Be(0);
    }

    [Fact]
    public async Task No_summary_when_the_filter_keeps_no_boluses_or_carb_intakes()
    {
        var stats = await Stats(TreatmentLogCategory.BgCheck, null);

        stats.Counts.Should().BeEquivalentTo(new TreatmentLogCounts { All = 1, BgCheck = 1 });
        stats.TreatmentSummary.Should().BeNull();
    }

    [Theory]
    [InlineData("insulin", TreatmentLogCategory.Bolus, 2)]
    [InlineData("normal", TreatmentLogCategory.Bolus, 1)]
    [InlineData("finger", TreatmentLogCategory.BgCheck, 1)]
    [InlineData("evening", TreatmentLogCategory.Note, 1)]
    [InlineData("sitechange", TreatmentLogCategory.DeviceEvent, 1)]
    [InlineData("long-acting", TreatmentLogCategory.BasalInjection, 1)]
    [InlineData("phone-c", TreatmentLogCategory.Carbs, 1)]
    public async Task Search_matches_kind_names_and_descriptive_fields(string search, TreatmentLogCategory kind, int expected)
    {
        var stats = await Stats(TreatmentLogCategory.All, search);

        stats.Counts.All.Should().Be(expected);
        CountOf(stats.Counts, kind).Should().Be(expected);
    }

    [Fact]
    public async Task Search_spans_fields_of_one_record()
    {
        var stats = await Stats(TreatmentLogCategory.All, "insulin normal");

        stats.Counts.Should().BeEquivalentTo(new TreatmentLogCounts { All = 1, Bolus = 1 });
    }

    [Fact]
    public async Task Rejects_an_empty_range_without_reading()
    {
        var result = await _controller.GetStats(To, From);

        result.Result.Should().BeOfType<ObjectResult>().Which.StatusCode.Should().Be(400);
        _boluses.VerifyNoOtherCalls();
    }

    private static int CountOf(TreatmentLogCounts counts, TreatmentLogCategory kind) => kind switch
    {
        TreatmentLogCategory.Bolus => counts.Bolus,
        TreatmentLogCategory.Carbs => counts.Carbs,
        TreatmentLogCategory.BgCheck => counts.BgCheck,
        TreatmentLogCategory.Note => counts.Note,
        TreatmentLogCategory.DeviceEvent => counts.DeviceEvent,
        TreatmentLogCategory.BasalInjection => counts.BasalInjection,
        _ => counts.All,
    };
}
