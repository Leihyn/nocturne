/**
 * This component ensures all theme classes are compiled by Tailwind.
 * It's never rendered but Tailwind scans this file for class names.
 */
export const ThemeSafelist = () => (
  <div className="hidden">
    {/* Backgrounds */}
    <div className="bg-[#0a0a0b] bg-[#0a0f1a] bg-[#0d0d0d] bg-[#1a1210] bg-[#0a1414]" />
    <div className="bg-gray-50 bg-white bg-neutral-950" />
    <div className="bg-zinc-900/50 bg-zinc-800 bg-zinc-800/50 bg-zinc-700" />
    <div className="bg-slate-900/60 bg-slate-800" />
    <div className="bg-neutral-900/80 bg-neutral-800 bg-neutral-700 bg-neutral-600" />
    <div className="bg-black/60 bg-black" />
    <div className="bg-stone-900/60 bg-stone-800" />
    <div className="bg-violet-600 bg-violet-500 bg-violet-900/10 bg-violet-900/20 bg-violet-900/30 bg-violet-900/40" />
    <div className="bg-emerald-600 bg-emerald-500 bg-emerald-900/10 bg-emerald-900/20 bg-emerald-900/30" />
    <div className="bg-blue-600 bg-blue-500 bg-blue-900/20" />
    <div className="bg-cyan-600 bg-cyan-500 bg-cyan-900/10 bg-cyan-900/20" />
    <div className="bg-teal-600 bg-teal-500 bg-teal-900/20 bg-teal-950/40" />
    <div className="bg-fuchsia-600 bg-fuchsia-500 bg-fuchsia-900/20 bg-fuchsia-950/30" />
    <div className="bg-green-500 bg-green-400 bg-green-900/20" />
    <div className="bg-orange-600 bg-orange-500 bg-orange-900/20" />
    <div className="bg-amber-600 bg-amber-500 bg-amber-900/20 bg-amber-900/10" />
    <div className="bg-gray-900 bg-gray-800 bg-gray-700 bg-gray-100" />

    {/* Text colors */}
    <div className="text-white text-gray-900 text-neutral-100" />
    <div className="text-zinc-400 text-zinc-500 text-zinc-600 text-zinc-200 text-zinc-300" />
    <div className="text-slate-300 text-slate-500" />
    <div className="text-neutral-300 text-neutral-400 text-neutral-600" />
    <div className="text-violet-400 text-violet-300 text-violet-600" />
    <div className="text-emerald-400 text-emerald-600" />
    <div className="text-blue-400 text-cyan-400" />
    <div className="text-teal-400 text-teal-200" />
    <div className="text-fuchsia-400 text-fuchsia-200" />
    <div className="text-green-400" />
    <div className="text-orange-400 text-orange-200" />
    <div className="text-amber-400" />
    <div className="text-gray-600 text-gray-400 text-gray-700" />

    {/* Borders */}
    <div className="border-zinc-800 border-zinc-700 border-zinc-700/50" />
    <div className="border-slate-700/50 border-slate-700 border-slate-600" />
    <div className="border-neutral-800 border-neutral-700" />
    <div className="border-violet-500/20 border-violet-800/50 border-violet-800" />
    <div className="border-emerald-800/50" />
    <div className="border-fuchsia-900/50 border-fuchsia-800" />
    <div className="border-orange-900/30 border-orange-900/50" />
    <div className="border-teal-900/40 border-teal-800" />
    <div className="border-gray-200 border-gray-300 border-gray-100" />

    {/* Hovers */}
    <div className="hover:bg-zinc-800/50 hover:bg-zinc-700/50 hover:bg-zinc-700 hover:bg-zinc-800" />
    <div className="hover:bg-slate-800/60" />
    <div className="hover:bg-neutral-800/80 hover:bg-neutral-600 hover:bg-neutral-500" />
    <div className="hover:bg-violet-500 hover:bg-violet-700" />
    <div className="hover:bg-emerald-500 hover:bg-emerald-700" />
    <div className="hover:bg-blue-500 hover:bg-cyan-500 hover:bg-teal-500" />
    <div className="hover:bg-fuchsia-500 hover:bg-green-400" />
    <div className="hover:bg-orange-500 hover:bg-amber-500" />
    <div className="hover:bg-gray-50 hover:bg-gray-800" />

    {/* Focus states */}
    <div className="focus:border-violet-500 focus:border-blue-500 focus:border-neutral-500" />
    <div className="focus:border-teal-500 focus:border-green-500 focus:border-orange-500 focus:border-amber-500" />
    <div className="focus:border-gray-400" />

    {/* Shadows */}
    <div className="shadow-violet-500/20 shadow-violet-500/30 shadow-black/20 shadow-black/40" />
    <div className="shadow-blue-500/30 shadow-blue-900/20" />
    <div className="shadow-neutral-500/10" />
    <div className="shadow-fuchsia-500/40 shadow-fuchsia-900/30" />
    <div className="shadow-orange-500/30 shadow-orange-900/20" />
    <div className="shadow-teal-500/30 shadow-teal-900/20" />
    <div className="shadow-gray-200/50 shadow-gray-300/50" />
    <div className="shadow-xl shadow-lg shadow-sm" />

    {/* Gradients */}
    <div className="from-violet-600 to-purple-600 from-emerald-600 to-teal-600" />
    <div className="from-violet-900/40 via-zinc-900/60 to-emerald-900/30" />
    <div className="from-violet-100/50 to-emerald-100/50 from-violet-50 via-white to-emerald-50" />
    <div className="from-blue-600 to-indigo-600 from-cyan-500 to-blue-500" />
    <div className="from-blue-900/30 via-slate-900/60 to-cyan-900/20" />
    <div className="from-neutral-600 to-neutral-700 from-neutral-500 to-neutral-600" />
    <div className="from-neutral-800/50 via-neutral-900/80 to-neutral-800/50" />
    <div className="from-fuchsia-600 to-pink-600 from-green-500 to-emerald-500" />
    <div className="from-fuchsia-900/30 via-black/80 to-green-900/20" />
    <div className="from-orange-600 to-red-600 from-amber-500 to-orange-500" />
    <div className="from-orange-900/30 via-stone-900/80 to-amber-900/20" />
    <div className="from-teal-600 to-cyan-600" />
    <div className="from-teal-900/30 via-slate-900/80 to-cyan-900/20" />
    <div className="from-gray-800 to-gray-900 from-gray-600 to-gray-700" />
    <div className="from-gray-50 to-gray-100" />
    <div className="from-violet-900/10 to-emerald-900/10 from-blue-900/20 to-cyan-900/10" />
    <div className="from-neutral-900/50 to-neutral-900/50 from-fuchsia-900/20 to-green-900/20" />
    <div className="from-orange-900/20 to-amber-900/10 from-teal-900/20 to-cyan-900/10" />

    {/* Background gradients */}
    <div className="bg-gradient-to-br" />
  </div>
);
