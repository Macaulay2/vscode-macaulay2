needsPackage "Style"

generateGrammar("syntaxes/macaulay2.tmLanguage.json", demark_"|")
generateGrammar("src/completionProviders.ts",x -> demark(", ", format \ x))
