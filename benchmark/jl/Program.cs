using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;
using JL.Core;
using JL.Core.Config;
using JL.Core.Deconjugation;
using JL.Core.Dicts;
using JL.Core.Dicts.Options;
using JL.Core.Lookup;
using JL.Core.Utilities.Database;

if (args.Length != 1)
{
    Console.Error.WriteLine("usage: JLBenchmark <input.json>");
    return 2;
}

var jsonOptions = new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
};

try
{
    var input = JsonSerializer.Deserialize<Input>(await File.ReadAllTextAsync(args[0]), jsonOptions)
        ?? throw new InvalidOperationException("input JSON is empty");
    if (input.Queries.Length == 0 || input.LookupPasses < 1)
    {
        throw new InvalidOperationException("queries and lookupPasses must be non-empty");
    }

    string archive = Path.GetFullPath(input.Archive);
    string runRoot = Path.GetFullPath(input.WorkDirectory);
    string extracted = Path.Join(runRoot, "dictionary");
    string dbDirectory = Path.Join(AppInfo.ResourcesPath, "Dictionary Databases");
    if (Directory.Exists(runRoot)) Directory.Delete(runRoot, true);
    if (Directory.Exists(dbDirectory)) Directory.Delete(dbDirectory, true);
    Directory.CreateDirectory(extracted);
    Directory.CreateDirectory(dbDirectory);

    await DeconjugatorUtils.DeserializeRules();
    CoreConfigManager.CreateNewCoreConfigManager();
    CoreConfigManager.Instance.LookupCategory = LookupCategory.All;
    DictUtils.Dicts.Clear();
    DictUtils.SingleDictTypeDicts.Clear();

    long importStarted = Stopwatch.GetTimestamp();
    ZipFile.ExtractToDirectory(archive, extracted);
    using (JsonDocument index = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Join(extracted, "index.json"))))
    {
        string title = index.RootElement.GetProperty("title").GetString()
            ?? throw new InvalidOperationException("dictionary index has no title");
        if (!String.Equals(title, input.ExpectedTitle, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"dictionary title {title} does not match {input.ExpectedTitle}");
        }
    }

    var options = new DictOptions(
        new UseDBOption(true),
        new NoAllOption(false),
        new NewlineBetweenDefinitionsOption(true),
        showImages: new ShowImagesOption(true),
        showImageAtBottom: new ShowImageAtBottomOption(true),
        maxImageWidth: new MaxImageWidthOption(0),
        maxImageHeight: new MaxImageHeightOption(0));
    var dictionary = new Dict(
        DictType.NonspecificWordYomichan,
        $"Hachidori Benchmark {input.Corpus}",
        extracted,
        true,
        1,
        0,
        options);
    DictUtils.Dicts.Add(dictionary.Name, dictionary);
    await DictUtils.LoadDictionaries();
    long importCoreEnded = Stopwatch.GetTimestamp();

    string databasePath = DBUtils.GetDictDBPath(dictionary.Name);
    if (!dictionary.Active || !dictionary.Ready || dictionary.Size <= 0 || !File.Exists(databasePath))
    {
        throw new InvalidOperationException(
            $"dictionary not ready: active={dictionary.Active}, ready={dictionary.Ready}, size={dictionary.Size}, database={databasePath}");
    }

    Query firstQuery = input.Queries.First(query => query.Id == input.FirstHitQueryId);
    long firstStarted = Stopwatch.GetTimestamp();
    Detail firstLookup = Lookup(firstQuery, firstStarted);
    if (firstLookup.ResultCount == 0 || !firstLookup.Expressions.Contains(input.FirstHitExpectedExpression, StringComparer.Ordinal))
    {
        throw new InvalidOperationException("the first correctness-checked lookup did not return its expected expression");
    }
    long importEnded = Stopwatch.GetTimestamp();

    Pass warmup = RunPass(input.Queries, null);
    var passes = new Pass[input.LookupPasses];
    for (int index = 0; index < input.LookupPasses; index++)
    {
        passes[index] = RunPass(input.Queries, index);
    }

    long databaseBytes = new FileInfo(databasePath).Length;
    Assembly assembly = typeof(DictUtils).Assembly;
    Guid moduleVersionId = assembly.ManifestModule.ModuleVersionId;
    var result = new Result(
        Milliseconds(importStarted, importEnded),
        Milliseconds(importStarted, importCoreEnded),
        firstLookup,
        warmup,
        passes,
        new Evidence(
            input.SourceCommit,
            assembly.FullName ?? assembly.GetName().Name ?? "JL.Core",
            moduleVersionId.ToString("D"),
            "JL.Core.Dicts.DictUtils.LoadDictionaries",
            "JL.Core.Lookup.LookupUtils.LookupText",
            dictionary.Active,
            dictionary.Ready,
            dictionary.Size,
            databaseBytes,
            input.ExpectedTitle),
        false);

    DictUtils.Dicts.Clear();
    DictUtils.SingleDictTypeDicts.Clear();
    if (Directory.Exists(runRoot)) Directory.Delete(runRoot, true);
    if (Directory.Exists(dbDirectory)) Directory.Delete(dbDirectory, true);
    result = result with { CleanupVerified = !Directory.Exists(runRoot) && !Directory.Exists(dbDirectory) };
    if (!result.CleanupVerified) throw new InvalidOperationException("JL benchmark state cleanup was not verified");

    Console.WriteLine($"HACHIDORI_JL_RESULT={JsonSerializer.Serialize(result, jsonOptions)}");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.ToString());
    return 2;
}

static double Milliseconds(long started, long ended) => Stopwatch.GetElapsedTime(started, ended).TotalMilliseconds;

static Detail Lookup(Query query, long started)
{
    LookupResult[] results = LookupUtils.LookupText(query.Text) ?? [];
    long ended = Stopwatch.GetTimestamp();
    string[] expressions = results
        .Select(result => result.PrimarySpelling)
        .Where(value => !String.IsNullOrEmpty(value))
        .Distinct(StringComparer.Ordinal)
        .Order(StringComparer.Ordinal)
        .ToArray();
    return new Detail(
        query.Id,
        query.Text,
        Milliseconds(started, ended),
        results.Length,
        expressions);
}

static Pass RunPass(Query[] queries, int? index)
{
    long started = Stopwatch.GetTimestamp();
    Detail[] details = queries.Select(query => Lookup(query, Stopwatch.GetTimestamp())).ToArray();
    long ended = Stopwatch.GetTimestamp();
    return new Pass(index, Milliseconds(started, ended), details);
}

public sealed record Input(
    string Archive,
    string WorkDirectory,
    string Corpus,
    string ExpectedTitle,
    string SourceCommit,
    string FirstHitQueryId,
    string FirstHitExpectedExpression,
    int LookupPasses,
    Query[] Queries);

public sealed record Query(string Id, string Text);

public sealed record Detail(
    string QueryId,
    string Text,
    double LatencyMs,
    int ResultCount,
    string[] Expressions);

public sealed record Pass(int? Index, double WallMs, Detail[] Details);

public sealed record Evidence(
    string SourceCommit,
    string Assembly,
    string ModuleVersionId,
    string LoadPath,
    string LookupPath,
    bool DictionaryActive,
    bool DictionaryReady,
    int DictionarySize,
    long DatabaseBytes,
    string DictionaryTitle);

public sealed record Result(
    double ImportUsableWallMs,
    double ImportCoreWallMs,
    Detail FirstLookup,
    Pass Warmup,
    Pass[] Passes,
    Evidence Evidence,
    bool CleanupVerified);
