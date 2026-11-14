namespace Vroom.Core.Domain;

/// <summary>Navigation metadata only; never grants authority or changes a task's frozen scope.</summary>
public sealed record TaskOrigin(string TabId, string Title)
{
    internal static readonly AsyncLocal<TaskOrigin?> Current = new();
}
