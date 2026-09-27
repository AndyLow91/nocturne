using Nocturne.Core.Contracts.Repositories;
using Nocturne.Infrastructure.Data;
using Nocturne.Infrastructure.Data.Repositories;

namespace Nocturne.API.Services.Alerts;

/// <summary>
/// Drops a rule's re-arm hold (docs/alerts/engine-semantics.md §6.3) once a write changes what
/// it was taken against. That is the rule's condition, auto-resolve configuration or
/// enablement. Every writer of alert rules goes through here.
/// </summary>
/// <remarks>
/// Under the lease, no evaluation in this process can read the hold and then find it cleared
/// when it writes, and a hold one sets just before is read and cleared here. Another replica
/// reads outside the transition lock. An evaluation there that read the hold just before
/// this clears it drops its decision, as for any state changed under it.
/// <para>
/// An evaluation that read the rule before the save, and takes the lease after this clear,
/// can still set a hold decided on the old conditions. The writer does not check which
/// version of the rule a decision was made against.
/// </para>
/// </remarks>
/// <param name="gate">The in-process per-rule lease the tracker holds across read, decide and write.</param>
/// <param name="repository">The tracker state store, whose transition lock the tracker's writer takes.</param>
public sealed class AlertRuleRearm(AlertRuleEvaluationGate gate, IAlertTrackerRepository repository)
{
    /// <summary>
    /// Clears the hold of each of <paramref name="ruleIds"/> that has one, after the rule changes
    /// are saved. Each rule is read and cleared in its own transaction, under the lease and
    /// transition lock the tracker's writer takes.
    /// </summary>
    public async Task ClearAsync(IReadOnlyCollection<Guid> ruleIds, CancellationToken ct)
    {
        foreach (var ruleId in ruleIds)
        {
            using var lease = await gate.AcquireAsync(ruleId, ct);
            await repository.ExecuteInTransactionAsync(async token =>
            {
                await repository.LockRuleAsync(ruleId, token);
                return await ClearHoldAsync(repository, ruleId, token);
            }, ct: ct);
        }
    }

    /// <summary>
    /// Saves the changes <paramref name="db"/> tracks for rule <paramref name="ruleId"/> and
    /// clears its hold in one transaction on that context, under the lease and transition lock
    /// the tracker's writer takes, so that neither lands without the other.
    /// </summary>
    /// <param name="db">The tenant context the rule was loaded and edited on.</param>
    /// <param name="ruleId">The edited rule.</param>
    /// <param name="ct">Cancellation token.</param>
    public async Task SaveAndClearAsync(NocturneDbContext db, Guid ruleId, CancellationToken ct)
    {
        using var lease = await gate.AcquireAsync(ruleId, ct);
        var tracker = new AlertTrackerRepository(db);
        await tracker.ExecuteInTransactionAsync(async token =>
        {
            await tracker.LockRuleAsync(ruleId, token);
            await db.SaveChangesAsync(token);
            return await ClearHoldAsync(tracker, ruleId, token);
        }, ct: ct);
    }

    private static async Task<bool> ClearHoldAsync(
        IAlertTrackerRepository tracker, Guid ruleId, CancellationToken ct)
    {
        var state = await tracker.GetTrackerStateAsync(ruleId, ct);
        if (state is not { AwaitingRearm: true })
            return false;
        state.AwaitingRearm = false;
        await tracker.UpsertTrackerStateAsync(state, ct);
        return true;
    }
}
