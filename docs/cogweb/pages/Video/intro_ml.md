---
jupyter:
  jupytext:
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  kernelspec:
    display_name: Python [conda env:.conda-cogweb]
    language: python
    name: conda-env-.conda-cogweb-py
---

<!-- #raw raw_mimetype="text/restructuredtext" -->
.. meta::
   :description: Topic: machine learning, Category: Section
   :keywords: introduction, summary, computer vision, natural language processing
<!-- #endraw -->

# A Brief Introduction to Machine Learning

An essential element of intelligence, as we recognize it in ourselves and in other animals, is the ability to observe and to make predictions or decisions based off those observations.
Indeed, the members of STEM fields align in their quest to find rules, laws, and relationships that permit us to systematically transform observations into reliable predictions or useful decisions.


<!-- #raw raw_mimetype="text/html" -->
<div style="text-align: center">
<p>
<img src="../_images/observation_to_prediction.png" alt="Intelligent systems can make reliable decisions or predictions in light of new observations" width="600">
</p>
</div>
<!-- #endraw -->

To successfully distill such a pattern in a way that can be leveraged consistently is to acquire a certain amount of wisdom; to do so feels like obtaining a nugget of truth, or that some amount of chaos has been turned into order.
Or, it might just mean that you can get a computer to tell the difference between cats and dogs in pictures.

Practitioners of machine learning (ML) strive to create computer programs that can distill meaningful patterns or rules from observations (i.e. data – to put in a less anthropomorphic way).
Conventional computer programs have static rules codified in them by humans, which permit the computer to transform input data into useful output data in a systematic way.
Thus, humans have traditionally been responsible for figuring out the rules that get used by computer programs.

<!-- #raw raw_mimetype="text/html" -->
<div style="text-align: center">
<p>
<img src="../_images/manual_computer_program.png" alt="Humans have traditionally been responsible for determining the rules that become codified in an intelligent computer program" width="600">
</p>
</div>
<!-- #endraw -->

For example, in a "classical" chess computer program (e.g. [Stockfish](https://stockfishchess.org/)), humans were responsible for designing and encoding the search patterns, types of analyses, and strategies that the chess-playing computer would rotely follow in order to try to win in a chess game.
In this classical computer program, human intuition and expertise in chess are distilled into the computer program and are amplified by the computational power of the machine.

By contrast, the goal of a ML algorithm is for _the machine_ to arrive at such rules by learning from both the data and the predictions that we would like our model to make about the data (here the term "rules" is to be taken in a very broad sense — it is more correct to say that the algorithm will arrive at a "mathematical description" of patterns that are pertinent to the problem at hand).

<!-- #raw raw_mimetype="text/html" -->
<div style="text-align: center">
<p>
<img src="../_images/ml_computer_program.png" alt="Machine learning systems are capable of determining the rules that will enable an intelligent system to make reliable predictions" width="600">
</p>
</div>
<!-- #endraw -->

Extending the chess analogy: a machine learning algorithm might learn chess strategy – for itself – by processing games played by chess grand masters, or it might even learn winning strategies simply by playing and "studying" (_many_) games against itself.
Here, humans didn't need to know how to write a winning chess algorithm, rather they needed to design a system by which a machine had the capacity and objective to _learn_ how to win at chess.

While a purely academic or even philosophical interest could lead one to design an algorithm capable of learning, a pragmatic thrust of ML is the insight that *machines may be able to learn solutions to problems that are superior to any solution that we know how to construct by hand*.
Indeed, this is certainly proving to be the case in fields like computer vision, natural language processing, and game artificial intelligence.
[AlphaZero](https://deepmind.com/blog/article/alphazero-shedding-new-light-grand-games-chess-shogi-and-go) is an example of a machine learning algorithm capable of enabling machines to learn to play chess, shogi, and the game Go at elite levels, such that human experts and classical algorithms are defeated by the strategies learned by AlphaGo.



<!-- #raw raw_mimetype="text/html" -->
<div style="text-align: center">
</p>
<iframe width="560" height="315" src="https://www.youtube.com/embed/7L2sUGcOgh0" frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
</p>
</div>
<!-- #endraw -->

<!-- #region -->
Despite all of this fanciful discussion, we must note that, in practice, a typical ML application will be highly limited in the ways it "learns" – it will not formulate its own hypotheses to be tested, nor will it query the Internet to discover new information; rather, we will see that "learning" is often used to describe processes of rote numerical optimization.
It is useful for us to quickly ground ourselves in this reality: the typical ML application is a relatively simple computer program that encapsulates perhaps-sophisticated-but-still-familiar mathematics, which were put there by humans.
To heed these considerations will help keep us from assuming that machine learning is a discipline so exotic and advanced that we, the wary students of this course, could never hope to participate in it — this is certainly not the case!


There are two major topics that we will be discussing in this module: 

1. What it looks like for a model to learn
2. The process and challenge of designing a mathematical model that is suitable for learning fruitful patterns from data

These discussions will lead us down a road towards the fundamentals of neural networks and computer vision applications that are driven by deep learning.

We will start off by tackling a simple problem: using a single-variable linear model to describe the relationship between height and wingspan in basketball players.
This approach to modeling is known as **linear regression**; while it is a stretch to categorize this as a machine learning algorithm, it will introduce us to all of the essential concepts needed for understanding the procedure of **supervised learning** nonetheless. 
<!-- #endregion -->
