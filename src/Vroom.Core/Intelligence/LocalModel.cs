using System.Text;
using LLama;
using LLama.Common;
using LLama.Sampling;
using Vroom.Core.Storage;

namespace Vroom.Core.Intelligence;

public interface ILocalModel
{
    Task<string> CompleteJsonAsync(string system, string request, CancellationToken ct);
    Task<string> CompleteToolAsync(string system, string request, IReadOnlyList<string> tools, CancellationToken ct) =>
        CompleteJsonAsync(system, request, ct);
}

public sealed class LocalModel(CatalogRepository repository) : ILocalModel, IDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private LLamaWeights? weights;
    private string? loadedPath;

    // All responses are constrained to JSON; model output still passes normal tool argument/domain validation.
    private const string JsonGrammar = """
        root ::= object
        value ::= object | array | string | number | "true" | "false" | "null"
        object ::= "{" ws (string ws ":" ws value (ws "," ws string ws ":" ws value)*)? ws "}"
        array ::= "[" ws (value (ws "," ws value)*)? ws "]"
        string ::= "\"" ([^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]))* "\""
        number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
        ws ::= [ \t\n\r]*
        """;

    public Task<string> CompleteJsonAsync(string system, string request, CancellationToken ct) =>
        CompleteAsync(system, request, JsonGrammar, ct);

    public Task<string> CompleteToolAsync(
        string system,
        string request,
        IReadOnlyList<string> tools,
        CancellationToken ct
    )
    {
        var root =
            "root ::= \"{\" ws \"\\\"tool\\\"\" ws \":\" ws tool ws \",\" ws \"\\\"arguments\\\"\" ws \":\" ws object ws \"}\"";
        var choices = string.Join(
            " | ",
            tools.Select(name => System.Text.Json.JsonSerializer.Serialize("\"" + name + "\""))
        );
        return CompleteAsync(
            system,
            request,
            JsonGrammar.Replace("root ::= object", root) + "\n" + "tool ::= " + choices,
            ct
        );
    }

    private async Task<string> CompleteAsync(string system, string request, string grammar, CancellationToken ct)
    {
        if (request.Length + system.Length > 100000)
            throw new ArgumentException("host.LocalModel.theAssistantContextIsTooLongNarrow");
        await gate.WaitAsync(ct);
        try
        {
            return await Task.Run(
                async () =>
                {
                    var modelPath = Vroom
                        .Core.Media.MediaRuntime.Resolve(await repository.SettingsAsync(ct))
                        .Model.Path;
                    if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
                        throw new FileNotFoundException("host.LocalModel.theLocalModelIsNotReadySelect");
                    var parameters = new ModelParams(modelPath)
                    {
                        ContextSize = 16384,
                        GpuLayerCount = 0,
                        Threads = Math.Clamp(Environment.ProcessorCount / 2, 1, 8),
                        BatchSize = 256,
                    };
                    if (weights is null || loadedPath != modelPath)
                    {
                        weights?.Dispose();
                        weights = await LLamaWeights.LoadFromFileAsync(parameters, ct);
                        loadedPath = modelPath;
                    }
                    var executor = new StatelessExecutor(weights, parameters) { ApplyTemplate = false };
                    var prompt =
                        $"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{request}<|im_end|>\n<|im_start|>assistant\n";
                    var result = new StringBuilder();
                    await foreach (
                        var token in executor.InferAsync(
                            prompt,
                            new InferenceParams
                            {
                                MaxTokens = 2048,
                                AntiPrompts = ["<|im_end|>"],
                                SamplingPipeline = new DefaultSamplingPipeline
                                {
                                    Temperature = 0.1f,
                                    Grammar = new Grammar(grammar, "root"),
                                },
                            },
                            ct
                        )
                    )
                        result.Append(token);
                    return result.ToString();
                },
                ct
            );
        }
        finally
        {
            gate.Release();
        }
    }

    public void Dispose()
    {
        weights?.Dispose();
        gate.Dispose();
    }
}
